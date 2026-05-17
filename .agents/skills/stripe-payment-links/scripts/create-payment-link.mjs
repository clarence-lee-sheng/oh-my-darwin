#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRIPE_BASE_URL = "https://api.stripe.com/v1";
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

function usage() {
  console.log(`Usage:
  create-payment-link.mjs \\
    --product-name "Consulting Session" \\
    --amount 750 \\
    --currency usd \\
    --confirm-live

Required for live create:
  STRIPE_API_KEY or STRIPE_SECRET_KEY in the target repo's .env or shell environment.

Required arguments:
  --product-name NAME          Stripe product name
  --amount AMOUNT              Major-unit amount, e.g. 750 or 750.50
  --currency CURRENCY          ISO currency, e.g. usd

Common options:
  --repo-root PATH             Target repo root. Defaults to walking up from cwd for .env/package.json
  --unit-amount AMOUNT         Minor-unit integer amount, e.g. 75000 for $750.00
  --quantity N                 Defaults to 1
  --description TEXT           Stripe product description
  --payment-method card        Repeat or comma-separate. Defaults to card
  --single-use                 Limit the Payment Link to one completed checkout
  --reusable                   Reusable Payment Link (default)
  --allow-promotion-codes      Enable promotion codes
  --confirmation-message TEXT  Hosted confirmation message after checkout
  --metadata key=value         Repeat for Stripe metadata
  --offer-key KEY              Metadata key used to find/reuse product/price/link
  --no-reuse                   Create a new Payment Link even if one exists for the offer key
  --idempotency-key KEY        Override Payment Link idempotency key
  --dry-run                    Validate inputs and print a sanitized plan without network calls
  --confirm-live               Required when the local Stripe key appears to be live

Output:
  Sanitized JSON containing payment_link.id, payment_link.url, livemode, amount, currency, and item summary.
`);
}

function parseArgs(argv) {
  const args = { _: [], metadata: [], "payment-method": [] };

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
      [
        "help",
        "h",
        "single-use",
        "reusable",
        "allow-promotion-codes",
        "no-reuse",
        "dry-run",
        "confirm-live",
      ].includes(key);
    const value = booleanFlag ? true : next;
    if (!booleanFlag) i += 1;

    if (key === "metadata") args.metadata.push(value);
    else if (key === "payment-method") args["payment-method"].push(value);
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

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function splitList(values, fallback = []) {
  const raw = Array.isArray(values) ? (values.length ? values : fallback) : values ? [values] : fallback;
  return raw
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseMetadata(values) {
  const metadata = {};
  for (const entry of values || []) {
    const index = String(entry).indexOf("=");
    if (index <= 0) throw new Error(`Invalid --metadata ${entry}; expected key=value.`);
    metadata[String(entry).slice(0, index)] = String(entry).slice(index + 1);
  }
  return metadata;
}

function parseQuantity(value) {
  const quantity = Number.parseInt(String(value ?? "1"), 10);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("--quantity must be a positive integer.");
  }
  return quantity;
}

function currencyExponent(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 0 : 2;
}

function parseAmountToMinor(amount, currency) {
  if (amount === undefined || amount === true) throw new Error("Missing --amount.");

  const exponent = currencyExponent(currency);
  const normalized = String(amount).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("--amount must be a positive number, e.g. 750 or 750.50.");
  }

  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > exponent) {
    throw new Error(`--amount has too many decimal places for ${currency.toUpperCase()}.`);
  }

  const minor =
    Number.parseInt(whole, 10) * 10 ** exponent +
    Number.parseInt(fractional.padEnd(exponent, "0") || "0", 10);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("--amount must be greater than zero.");
  }
  return minor;
}

function formatAmount(minor, currency) {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
}

function looksLiveKey(apiKey) {
  return /^(sk|rk)_live_/.test(apiKey);
}

function stripeAuthHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function stripeRequest(apiKey, method, endpoint, params = {}, idempotencyKey) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }

  const isGet = method === "GET";
  const suffix = isGet && body.size ? `?${body}` : "";
  const response = await fetch(`${STRIPE_BASE_URL}${endpoint}${suffix}`, {
    method,
    headers: {
      Authorization: stripeAuthHeader(apiKey),
      ...(isGet ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: isGet ? undefined : body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message || response.statusText;
    throw new Error(`Stripe ${response.status}: ${message}`);
  }
  return data;
}

function metadataParams(plan) {
  return {
    ...Object.fromEntries(
      Object.entries(plan.metadata).map(([key, value]) => [`metadata[${key}]`, value]),
    ),
    "metadata[source]": "stripe-payment-links-skill",
    "metadata[offer_key]": plan.offerKey,
  };
}

async function findProduct(apiKey, offerKey) {
  const products = await stripeRequest(apiKey, "GET", "/products", {
    active: true,
    limit: 100,
  });
  return products.data.find((product) => product.metadata?.offer_key === offerKey);
}

async function findPrice(apiKey, productId, plan) {
  const prices = await stripeRequest(apiKey, "GET", "/prices", {
    active: true,
    product: productId,
    limit: 100,
  });
  return prices.data.find(
    (price) =>
      price.metadata?.offer_key === plan.offerKey &&
      price.currency === plan.currency &&
      price.unit_amount === plan.unitAmount &&
      price.type === "one_time",
  );
}

async function findPaymentLink(apiKey, offerKey) {
  const links = await stripeRequest(apiKey, "GET", "/payment_links", {
    active: true,
    limit: 100,
  });
  return links.data.find((link) => link.metadata?.offer_key === offerKey);
}

async function createProduct(apiKey, plan) {
  return stripeRequest(
    apiKey,
    "POST",
    "/products",
    {
      name: plan.productName,
      description: plan.description,
      ...metadataParams(plan),
    },
    `${plan.offerKey}_product`,
  );
}

async function createPrice(apiKey, productId, plan) {
  return stripeRequest(
    apiKey,
    "POST",
    "/prices",
    {
      currency: plan.currency,
      unit_amount: plan.unitAmount,
      product: productId,
      ...metadataParams(plan),
    },
    `${plan.offerKey}_price`,
  );
}

async function createPaymentLink(apiKey, priceId, plan) {
  const params = {
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": plan.quantity,
    "after_completion[type]": "hosted_confirmation",
    "after_completion[hosted_confirmation][custom_message]": plan.confirmationMessage,
    ...metadataParams(plan),
  };

  plan.paymentMethodTypes.forEach((method, index) => {
    params[`payment_method_types[${index}]`] = method;
  });

  if (plan.allowPromotionCodes) params.allow_promotion_codes = true;
  if (plan.singleUse) params["restrictions[completed_sessions][limit]"] = 1;

  return stripeRequest(apiKey, "POST", "/payment_links", params, plan.idempotencyKey);
}

async function getOrCreatePaymentLink(apiKey, plan) {
  if (plan.reuse) {
    const existingLink = await findPaymentLink(apiKey, plan.offerKey);
    if (existingLink) return { link: existingLink, created: false };
  }

  const product = (await findProduct(apiKey, plan.offerKey)) || (await createProduct(apiKey, plan));
  const price = (await findPrice(apiKey, product.id, plan)) || (await createPrice(apiKey, product.id, plan));
  const link = await createPaymentLink(apiKey, price.id, plan);
  return { link, created: true };
}

function buildPlan(args) {
  const productName = args["product-name"];
  if (!productName || productName === true) throw new Error("Missing --product-name.");

  const currency = String(args.currency || "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error("--currency must be a 3-letter ISO currency.");

  const unitAmount =
    args["unit-amount"] && args["unit-amount"] !== true
      ? Number.parseInt(String(args["unit-amount"]), 10)
      : parseAmountToMinor(args.amount, currency);
  if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
    throw new Error("--unit-amount must be a positive integer minor-unit amount.");
  }

  const quantity = parseQuantity(args.quantity);
  const singleUse = Boolean(args["single-use"]);
  const metadata = parseMetadata(args.metadata);
  const paymentMethodTypes = splitList(args["payment-method"], ["card"]);
  const offerKey =
    args["offer-key"] && args["offer-key"] !== true
      ? String(args["offer-key"])
      : [
          slugify(productName),
          unitAmount,
          currency,
          `qty${quantity}`,
          singleUse ? "single" : "reusable",
        ].join("_");
  const reuse = !args["no-reuse"];
  const idempotencyKey =
    args["idempotency-key"] && args["idempotency-key"] !== true
      ? String(args["idempotency-key"])
      : reuse
        ? `${offerKey}_payment_link_${singleUse ? "single" : "reusable"}`
        : `${offerKey}_payment_link_${Date.now()}`;

  return {
    productName: String(productName),
    description: args.description && args.description !== true ? String(args.description) : undefined,
    unitAmount,
    formattedAmount: formatAmount(unitAmount, currency),
    currency,
    quantity,
    singleUse,
    allowPromotionCodes: Boolean(args["allow-promotion-codes"]),
    confirmationMessage:
      args["confirmation-message"] && args["confirmation-message"] !== true
        ? String(args["confirmation-message"])
        : `Thanks. We received your payment for ${productName} and will follow up with next steps.`,
    paymentMethodTypes,
    offerKey: String(offerKey).slice(0, 120),
    idempotencyKey,
    metadata,
    reuse,
    dryRun: Boolean(args["dry-run"]),
    confirmLive: Boolean(args["confirm-live"]),
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
  const apiKey = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY;

  if (plan.dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          repo_root: repoRoot,
          loaded_env: loadedEnv,
          has_stripe_key: Boolean(apiKey),
          payment_link_plan: {
            product_name: plan.productName,
            amount: plan.unitAmount,
            formatted_amount: plan.formattedAmount,
            currency: plan.currency,
            quantity: plan.quantity,
            reusable: !plan.singleUse,
            single_use: plan.singleUse,
            payment_method_types: plan.paymentMethodTypes,
            allow_promotion_codes: plan.allowPromotionCodes,
            offer_key: plan.offerKey,
            reuse_existing_by_offer_key: plan.reuse,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!apiKey) throw new Error("Missing STRIPE_API_KEY or STRIPE_SECRET_KEY in target repo .env or environment.");
  if (looksLiveKey(apiKey) && !plan.confirmLive) {
    throw new Error(
      "Local Stripe key appears to be live. Re-run with --confirm-live after confirming merchant/account, product, amount, currency, quantity, link type, and payment method.",
    );
  }

  const { link, created } = await getOrCreatePaymentLink(apiKey, plan);
  console.log(
    JSON.stringify(
      {
        payment_link: {
          id: link.id,
          url: link.url,
          livemode: link.livemode,
          active: link.active,
          created,
          product_name: plan.productName,
          amount: plan.unitAmount,
          formatted_amount: plan.formattedAmount,
          currency: plan.currency,
          quantity: plan.quantity,
          reusable: !plan.singleUse,
          single_use: plan.singleUse,
          payment_method_types: plan.paymentMethodTypes,
          offer_key: plan.offerKey,
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
