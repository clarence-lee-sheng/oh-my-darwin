---
name: agentmail
description: Give AI agents their own email inboxes using the AgentMail API. Use when sending email through AgentMail from a repo-local .env, creating/listing inboxes, managing messages/threads/drafts/attachments/labels, or setting up webhooks/websockets for agent email workflows.
---

# AgentMail

Use AgentMail for agent-owned inboxes and programmatic email. Never read, print, or ask the user to paste `AGENTMAIL_API_KEY`; use repo-local environment loading or an already-configured shell environment.

## One-off email script

Prefer the bundled script for repeatable one-off sends:

```bash
.agents/skills/agentmail/scripts/send-email.mjs \
  --to customer@example.com \
  --subject "Payment link" \
  --text "Here is your link: {{url}}" \
  --url "https://example.com"
```

The script is repo-agnostic:

- Run it from the target repo, or pass `--repo-root /path/to/repo`.
- It walks up from `cwd` to find the target repo `.env`/`package.json` and loads `.env` itself with no npm dependency.
- It requires `AGENTMAIL_API_KEY` for live send.
- It uses `AGENTMAIL_FROM_INBOX` when set; otherwise it lists inboxes and uses the first one.
- It creates an inbox only when `--create-inbox` is passed.
- It always sends both text and HTML, generating one from the other when needed.
- It prints sanitized JSON with `to`, `from_inbox`, `message_id`, and `thread_id`.

Useful options:

```bash
# Validate without network calls
.agents/skills/agentmail/scripts/send-email.mjs \
  --to customer@example.com --subject "Hello" --text "Hi" --dry-run

# Send from a specific inbox
.agents/skills/agentmail/scripts/send-email.mjs \
  --from-inbox agent@example.com \
  --to customer@example.com \
  --subject "Hello" \
  --text "Hi"

# Create an inbox if none exists
.agents/skills/agentmail/scripts/send-email.mjs \
  --create-inbox --from-username agent --from-domain agentmail.to \
  --to customer@example.com --subject "Hello" --text "Hi"
```

Template tokens in `--text`, `--html`, `--text-file`, and `--html-file`: `{{url}}`, `{{productName}}`, `{{amount}}`.

## SDK pattern

For app code, use the AgentMail SDK and send both `text` and `html`:

```typescript
import { AgentMailClient } from "agentmail";
const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });

await client.inboxes.messages.send("agent@agentmail.to", {
  to: "recipient@example.com",
  subject: "Hello",
  text: "Plain text version",
  html: "<p>HTML version</p>",
  labels: ["outreach"],
});
```

## Inboxes and threads

- Create inboxes on demand with `client.inboxes.create({ username, domain })` or the API `POST /v0/inboxes`.
- List inboxes with `client.inboxes.list()` or `GET /v0/inboxes`.
- Group conversations with threads: `client.inboxes.threads.list(inboxId)` and `client.inboxes.threads.get(inboxId, threadId)`.
- Use drafts when a human should approve before sending.
- Base URL defaults to `https://api.agentmail.to`; use `https://api.agentmail.eu` for `am_eu_*` keys or `AGENTMAIL_BASE_URL`/`--agentmail-base-url` when needed.

## Real-time email

For real-time workflows, read only the needed reference:

- Webhooks: `references/webhooks.md`
- WebSockets: `references/websockets.md`
