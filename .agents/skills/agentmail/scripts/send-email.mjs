#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.log(`Usage:
  send-email.mjs \\
    --to customer@example.com \\
    --subject "Payment link" \\
    --text "Here is your link: {{url}}" \\
    --url "https://example.com"

Required for live send:
  AGENTMAIL_API_KEY in the target repo's .env or shell environment.

Required arguments:
  --to EMAIL                   Recipient email
  --subject TEXT               Email subject
  --text TEXT                  Plain-text body, unless --text-file or --html is provided

Common options:
  --repo-root PATH             Target repo root. Defaults to walking up from cwd for .env/package.json
  --from-inbox EMAIL           AgentMail inbox. Defaults to AGENTMAIL_FROM_INBOX or first inbox
  --from-username USER         Used only with --create-inbox if an inbox must be created
  --from-domain DOMAIN         Used only with --create-inbox. Defaults to agentmail.to
  --create-inbox               Create an inbox if no from inbox is found
  --agentmail-base-url URL     Defaults to api.agentmail.to, or api.agentmail.eu for am_eu_* keys
  --text-file PATH             Read plain-text body from a file
  --html TEXT                  HTML body. If omitted, generated from text
  --html-file PATH             Read HTML body from a file
  --cc EMAILS                  Comma-separated CC recipients
  --bcc EMAILS                 Comma-separated BCC recipients
  --reply-to EMAIL             Reply-To address
  --label LABEL                Repeat or comma-separate labels
  --url URL                    Template value for {{url}}
  --product-name NAME          Template value for {{productName}}
  --amount AMOUNT              Template value for {{amount}}
  --dry-run                    Validate inputs and print a sanitized plan without network calls

Template tokens in --text/--html/--*-file:
  {{url}}, {{productName}}, {{amount}}
`);
}

function parseArgs(argv) {
  const args = { _: [], labels: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    const booleanFlag =
      !next ||
      next.startsWith("--") ||
      ["help", "h", "dry-run", "create-inbox"].includes(key);
    const value = booleanFlag ? true : next;
    if (!booleanFlag) i += 1;

    if (key === "label") args.labels.push(value);
    else args[key] = value;
  }

  return args;
}

function findRepoRoot(start) {
  let current = path.resolve(start);

  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, ".env"))) return current;
    current = path.dirname(current);
  }

  current = path.resolve(start);
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }

  return null;
}

function resolveRepoRoot(args) {
  if (args["repo-root"] && args["repo-root"] !== true) {
    return path.resolve(String(args["repo-root"]));
  }

  const thisFile = fileURLToPath(import.meta.url);
  return findRepoRoot(process.cwd()) || findRepoRoot(path.dirname(thisFile)) || process.cwd();
}

function parseEnvValue(raw) {
  let value = raw.trim();
  if (value.startsWith("export ")) value = value.slice("export ".length).trim();

  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === `"`) {
      value = value
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\t", "\t")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\");
    }
  }

  return value;
}

function loadRepoEnv(repoRoot) {
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) return false;

  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals <= 0) continue;

    const key = line.slice(0, equals).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    process.env[key] = parseEnvValue(line.slice(equals + 1));
  }

  return true;
}

function splitList(values, fallback = []) {
  const raw = Array.isArray(values) ? (values.length ? values : fallback) : values ? [values] : fallback;
  return raw
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function readArgOrFile(args, key) {
  const fileValue = args[`${key}-file`];
  if (fileValue && fileValue !== true) {
    return readFileSync(path.resolve(String(fileValue)), "utf8");
  }

  const directValue = args[key];
  return directValue && directValue !== true ? String(directValue) : undefined;
}

function renderTemplate(template, values) {
  return String(template)
    .replaceAll("{{url}}", values.url || "")
    .replaceAll("{{productName}}", values.productName || "")
    .replaceAll("{{amount}}", values.amount || "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textToHtml(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function agentmailBaseUrl(apiKey, args) {
  if (args["agentmail-base-url"] && args["agentmail-base-url"] !== true) {
    return String(args["agentmail-base-url"]).replace(/\/+$/, "");
  }
  if (process.env.AGENTMAIL_BASE_URL) {
    return process.env.AGENTMAIL_BASE_URL.replace(/\/+$/, "");
  }
  return apiKey?.startsWith("am_eu_") ? "https://api.agentmail.eu" : "https://api.agentmail.to";
}

async function agentmailRequest(baseUrl, apiKey, method, endpoint, body, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }

  const suffix = params.size ? `?${params}` : "";
  const response = await fetch(`${baseUrl}${endpoint}${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message || data.message || response.statusText;
    throw new Error(`AgentMail ${response.status}: ${message}`);
  }

  return data;
}

function inboxId(inbox) {
  return inbox.inbox_id || inbox.inboxId || inbox.email;
}

async function resolveFromInbox(baseUrl, apiKey, plan) {
  if (plan.fromInbox) return plan.fromInbox;

  const response = await agentmailRequest(baseUrl, apiKey, "GET", "/v0/inboxes", undefined, {
    limit: 20,
  });
  const inboxes = response.inboxes || [];
  const configuredEmail =
    plan.fromUsername && plan.fromDomain ? `${plan.fromUsername}@${plan.fromDomain}` : null;

  const preferred =
    inboxes.find((inbox) => configuredEmail && inbox.email === configuredEmail) || inboxes[0];

  if (preferred) return inboxId(preferred);
  if (!plan.createInbox) {
    throw new Error("No AgentMail inbox found. Pass --from-inbox or --create-inbox.");
  }

  const body = {};
  if (plan.fromUsername) body.username = plan.fromUsername;
  if (plan.fromDomain) body.domain = plan.fromDomain;
  const created = await agentmailRequest(
    baseUrl,
    apiKey,
    "POST",
    "/v0/inboxes",
    Object.keys(body).length ? body : undefined,
  );
  return inboxId(created);
}

function buildPlan(args) {
  if (!args.to || args.to === true) throw new Error("Missing --to.");
  if (!args.subject || args.subject === true) throw new Error("Missing --subject.");

  const templateValues = {
    url: args.url && args.url !== true ? String(args.url) : "",
    productName:
      args["product-name"] && args["product-name"] !== true ? String(args["product-name"]) : "",
    amount: args.amount && args.amount !== true ? String(args.amount) : "",
  };

  let text = readArgOrFile(args, "text");
  let html = readArgOrFile(args, "html");
  if (!text && !html) throw new Error("Missing --text, --text-file, --html, or --html-file.");

  if (text) text = renderTemplate(text, templateValues);
  if (html) html = renderTemplate(html, templateValues);
  if (!html) html = textToHtml(text);
  if (!text) text = htmlToText(html);

  const fromUsername =
    args["from-username"] && args["from-username"] !== true
      ? String(args["from-username"])
      : process.env.AGENTMAIL_INBOX_USERNAME;
  const fromDomain =
    args["from-domain"] && args["from-domain"] !== true
      ? String(args["from-domain"])
      : process.env.AGENTMAIL_INBOX_DOMAIN || "agentmail.to";

  return {
    to: String(args.to),
    subject: String(args.subject),
    text,
    html,
    cc: splitList(args.cc),
    bcc: splitList(args.bcc),
    replyTo: args["reply-to"] && args["reply-to"] !== true ? String(args["reply-to"]) : undefined,
    labels: splitList(args.labels, ["agentmail-script"]),
    fromInbox:
      args["from-inbox"] && args["from-inbox"] !== true
        ? String(args["from-inbox"])
        : process.env.AGENTMAIL_FROM_INBOX,
    fromUsername,
    fromDomain,
    createInbox: Boolean(args["create-inbox"]),
    dryRun: Boolean(args["dry-run"]),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const repoRoot = resolveRepoRoot(args);
  const loadedEnv = loadRepoEnv(repoRoot);
  const plan = buildPlan(args);
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (plan.dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          repo_root: repoRoot,
          loaded_env: loadedEnv,
          has_agentmail_key: Boolean(apiKey),
          email_plan: {
            to: plan.to,
            from_inbox: plan.fromInbox || "auto",
            create_inbox_if_missing: plan.createInbox,
            subject: plan.subject,
            has_text: Boolean(plan.text),
            has_html: Boolean(plan.html),
            cc: plan.cc,
            bcc: plan.bcc,
            reply_to: plan.replyTo,
            labels: plan.labels,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!apiKey) throw new Error("Missing AGENTMAIL_API_KEY in target repo .env or environment.");

  const baseUrl = agentmailBaseUrl(apiKey, args);
  const fromInbox = await resolveFromInbox(baseUrl, apiKey, plan);
  const body = {
    to: plan.to,
    subject: plan.subject,
    text: plan.text,
    html: plan.html,
    labels: plan.labels,
  };
  if (plan.cc.length) body.cc = plan.cc;
  if (plan.bcc.length) body.bcc = plan.bcc;
  if (plan.replyTo) body.reply_to = plan.replyTo;

  const message = await agentmailRequest(
    baseUrl,
    apiKey,
    "POST",
    `/v0/inboxes/${encodeURIComponent(fromInbox)}/messages/send`,
    body,
  );

  console.log(
    JSON.stringify(
      {
        email: {
          to: plan.to,
          from_inbox: fromInbox,
          subject: plan.subject,
          message_id: message.message_id || message.messageId,
          thread_id: message.thread_id || message.threadId,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
