#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRIPE_BASE_URL = "https://api.stripe.com/v1";

function usage() {
  console.log(`Usage:
  stripe-status-from-repo.mjs sessions --payment-link plink_... [--limit 10]
  stripe-status-from-repo.mjs session --id cs_...
  stripe-status-from-repo.mjs balance
  stripe-status-from-repo.mjs balance-transactions [--limit 10]

Options:
  --repo-root PATH   Target repo root. Defaults to walking up from cwd for .env/package.json.
`);
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

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function createdToIso(created) {
  return typeof created === "number" ? new Date(created * 1000).toISOString() : null;
}

function compactSession(session) {
  return {
    id: session.id,
    payment_link: session.payment_link,
    status: session.status,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    created: createdToIso(session.created),
    payment_intent: session.payment_intent,
  };
}

function compactBalance(balance) {
  return {
    available: balance.available,
    pending: balance.pending,
  };
}

function compactBalanceTransaction(transaction) {
  return {
    id: transaction.id,
    amount: transaction.amount,
    currency: transaction.currency,
    fee: transaction.fee,
    net: transaction.net,
    type: transaction.type,
    reporting_category: transaction.reporting_category,
    status: transaction.status,
    source: transaction.source,
    created: createdToIso(transaction.created),
  };
}

async function stripeGet(apiKey, endpoint, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      query.append(key, String(value));
    }
  }

  const suffix = query.size ? `?${query}` : "";
  const response = await fetch(`${STRIPE_BASE_URL}${endpoint}${suffix}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data.error?.message || response.statusText;
    throw new Error(`Stripe ${response.status}: ${message}`);
  }

  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help || args.h) {
    usage();
    return;
  }

  const repoRoot = resolveRepoRoot(args);
  loadRepoEnv(repoRoot);
  const apiKey = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY;

  if (!apiKey) {
    throw new Error("Missing STRIPE_API_KEY or STRIPE_SECRET_KEY in target repo .env or environment.");
  }

  if (command === "sessions") {
    if (!args["payment-link"]) {
      throw new Error("Missing --payment-link plink_...");
    }

    const sessions = await stripeGet(apiKey, "/checkout/sessions", {
      payment_link: args["payment-link"],
      limit: args.limit || 10,
    });

    console.log(JSON.stringify(sessions.data.map(compactSession), null, 2));
    return;
  }

  if (command === "session") {
    if (!args.id) {
      throw new Error("Missing --id cs_...");
    }

    const session = await stripeGet(apiKey, `/checkout/sessions/${args.id}`);
    console.log(JSON.stringify(compactSession(session), null, 2));
    return;
  }

  if (command === "balance") {
    const balance = await stripeGet(apiKey, "/balance");
    console.log(JSON.stringify(compactBalance(balance), null, 2));
    return;
  }

  if (command === "balance-transactions") {
    const transactions = await stripeGet(apiKey, "/balance_transactions", {
      limit: args.limit || 10,
    });

    console.log(JSON.stringify(transactions.data.map(compactBalanceTransaction), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
