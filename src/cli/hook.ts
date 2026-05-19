#!/usr/bin/env node
import { dispatch } from "../hooks/extensibility/dispatcher.js";
import { formatErrorSummary, resolvePositiveInt } from "../runtime/diagnostics.js";

const DEFAULT_HOOK_STDIN_LIMIT_CHARS = 64_000;
const MAX_HOOK_STDIN_LIMIT_CHARS = 1_000_000;

type HookInput = AsyncIterable<Buffer | string>;

export interface RunHookOptions {
  eventLogStringLimitRaw?: string;
  pluginTimeoutMsRaw?: string;
  stdinLimitRaw?: string;
}

export async function runHook(
  argv: string[],
  input: HookInput = process.stdin,
  inputIsTty = Boolean(process.stdin.isTTY),
  options: RunHookOptions = {},
): Promise<void> {
  const event = normalizeHookEventArg(argv[0] ?? "unknown");
  const { raw, truncated } = await readHookInput(
    input,
    inputIsTty,
    hookStdinLimit(options.stdinLimitRaw),
  );
  const output = await dispatch(event, parseHookPayload(raw, truncated), {
    eventLogStringLimitRaw: options.eventLogStringLimitRaw,
    pluginTimeoutMsRaw: options.pluginTimeoutMsRaw,
  });
  if (typeof output === "string") {
    process.stdout.write(output);
  } else if (output && typeof output === "object") {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

export async function readHookInput(
  input: HookInput,
  inputIsTty: boolean,
  maxChars = hookStdinLimit(),
): Promise<{ raw: string; truncated: boolean }> {
  let raw = "";
  let totalChars = 0;
  if (inputIsTty) return { raw, truncated: false };

  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    totalChars += text.length;
    const remaining = maxChars - raw.length;
    if (remaining > 0) raw += text.slice(0, remaining);
  }

  return { raw, truncated: totalChars > maxChars };
}

export function parseHookPayload(
  raw: string,
  truncated = false,
): Record<string, unknown> {
  if (truncated) {
    return raw.trim()
      ? { _raw: raw, _raw_truncated: true }
      : { _raw_truncated: true };
  }

  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { payload: parsed };
  } catch {
    return { _raw: raw };
  }
}

function hookStdinLimit(raw = process.env.DARWIN_HOOK_STDIN_LIMIT_CHARS): number {
  return resolveHookStdinLimit(raw);
}

export function resolveHookStdinLimit(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_HOOK_STDIN_LIMIT_CHARS, MAX_HOOK_STDIN_LIMIT_CHARS);
}

function normalizeHookEventArg(event: string): string {
  const key = event.trim().replaceAll("-", "_").toLowerCase();
  const aliases: Record<string, string> = {
    sessionstart: "session_start",
    session_start: "session_start",
    pretooluse: "pre_tool_use",
    pre_tool_use: "pre_tool_use",
    permissionrequest: "permission_request",
    permission_request: "permission_request",
    posttooluse: "post_tool_use",
    post_tool_use: "post_tool_use",
    userpromptsubmit: "user_prompt_submit",
    user_prompt_submit: "user_prompt_submit",
    stop: "stop",
  };
  return aliases[key] ?? event;
}

export function formatHookFatalError(err: unknown): string {
  return `darwin-hook: ${formatErrorSummary(err)}\n`;
}

// Allow invocation as `darwin-hook <event>` (bin entry) and as `darwin hook <event>`.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  runHook(process.argv.slice(2)).catch((err) => {
    process.stderr.write(formatHookFatalError(err));
    process.exit(1);
  });
}
