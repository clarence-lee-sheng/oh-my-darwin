#!/usr/bin/env node
import { dispatch } from "../hooks/extensibility/dispatcher.js";

export async function runHook(argv: string[]): Promise<void> {
  const event = argv[0] ?? "unknown";

  let raw = "";
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) raw += chunk;
  }

  let payload: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { payload: parsed };
    } catch {
      payload = { _raw: raw };
    }
  }

  await dispatch(event, payload);
}

// Allow invocation as `darwin-hook <event>` (bin entry) and as `darwin hook <event>`.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  runHook(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`darwin-hook: ${err}\n`);
    process.exit(1);
  });
}
