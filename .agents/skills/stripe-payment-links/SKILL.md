---
name: stripe-payment-links
description: Create and monitor Stripe Payment Links using Stripe's API without exposing credentials. Use when Codex needs to create live or test payment links from configurable product name, amount, currency, quantity, payment methods, and reuse/single-use settings; verify whether a Payment Link was paid; inspect Checkout Sessions; or check Stripe balance/balance transactions.
---

# Stripe Payment Links

Create Stripe Payment Links with repo-local credentials. Never read, print, summarize, copy, or ask the user to paste Stripe keys; use the target repo `.env` or existing shell environment.

## Safety

- For live links, confirm merchant/account, product name, amount, currency, quantity, reusable vs single-use, and payment method type before creation.
- Use `--dry-run` first for custom links whenever possible.
- Use `--confirm-live` only after the live details are confirmed.
- Report only non-sensitive outputs: Payment Link `id`, `url`, `livemode`, `active`, amount/currency, quantity, and item summary.
- If emailing the link, use the separate AgentMail skill/script. Do not combine Stripe and email logic in this skill.

## Create a configurable Payment Link

Prefer the bundled repo-agnostic script:

```bash
.agents/skills/stripe-payment-links/scripts/create-payment-link.mjs \
  --product-name "Consulting Session" \
  --amount 750 \
  --currency usd \
  --confirm-live
```

The script:

- Runs from any target repo when invoked from that repo, or with `--repo-root /path/to/repo`.
- Walks up from `cwd` to find `.env`/`package.json`.
- Loads `.env` itself with no npm dependency.
- Requires `STRIPE_API_KEY` or `STRIPE_SECRET_KEY` for live execution.
- Uses inline `price_data` by creating/reusing a Product and Price by `metadata[offer_key]`.
- Creates/reuses a Payment Link by `metadata[offer_key]` unless `--no-reuse` is passed.
- Prints sanitized JSON including `payment_link.url`.

Common options:

```bash
# Validate without network calls
.agents/skills/stripe-payment-links/scripts/create-payment-link.mjs \
  --product-name "Consulting Session" \
  --amount 750 \
  --currency usd \
  --dry-run

# Single-use link
.agents/skills/stripe-payment-links/scripts/create-payment-link.mjs \
  --product-name "One-Time Setup" \
  --amount 1200 \
  --currency usd \
  --single-use \
  --confirm-live

# Minor-unit amount, metadata, and promotion codes
.agents/skills/stripe-payment-links/scripts/create-payment-link.mjs \
  --product-name "Sprint" \
  --unit-amount 250000 \
  --currency usd \
  --metadata source=agent \
  --allow-promotion-codes \
  --confirm-live
```

If the user wants the link emailed, run the AgentMail skill after Stripe returns the URL:

```bash
.agents/skills/agentmail/scripts/send-email.mjs \
  --to customer@example.com \
  --subject "Payment link" \
  --text "Here is the payment link for {{productName}} ({{amount}}): {{url}}" \
  --product-name "Consulting Session" \
  --amount '$750.00' \
  --url "https://buy.stripe.com/..."
```

## Minimal Stripe permissions

- Existing `price_...` only: `Payment Links: Write` and `Checkout Sessions: Read`.
- This script creates/reuses Products and Prices from inline data: add `Products: Write` and `Prices: Write`.
- Balance checks: add `Balance: Read` and `Balance Transactions: Read` only when explicitly needed.

## Monitor Payment Status

Use the bundled status helper. It also reads the target repo `.env` with no npm dependency.

```bash
.agents/skills/stripe-payment-links/scripts/stripe-status-from-repo.mjs sessions \
  --payment-link plink_... \
  --limit 10
```

Treat a session as paid only when `status` is `complete`, `payment_status` is `paid`, and `amount_total`/`currency` match the expected purchase.

Retrieve a known Checkout Session:

```bash
.agents/skills/stripe-payment-links/scripts/stripe-status-from-repo.mjs session --id cs_...
```

Balance checks are secondary evidence only:

```bash
.agents/skills/stripe-payment-links/scripts/stripe-status-from-repo.mjs balance
.agents/skills/stripe-payment-links/scripts/stripe-status-from-repo.mjs balance-transactions --limit 10
```

Do not infer a specific Payment Link was paid from balance alone unless the related PaymentIntent/Checkout Session ties it back to the link.

## Common errors

- `payment_link_no_valid_payment_methods`: enable a compatible Stripe payment method or pass an enabled method such as `--payment-method card`.
- `resource_missing` for a placeholder `price_...`: use a real Price ID or use this script's inline product/price flow.
- restricted-key permission error: add only the missing permission required by the chosen flow.
