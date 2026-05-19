import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVENTS_LOG, DARWIN_DIR } from "../../cli/constants.js";
import {
  formatDurationMs,
  formatErrorSummary,
  resolvePositiveInt,
} from "../../runtime/diagnostics.js";
import { writeTerminalError } from "../../runtime/terminal.js";
import { loadPlugins } from "./loader.js";
import type {
  HookHandler,
  HookHandlerOutput,
  HookPayload,
  DarwinPlugin,
  LifecycleEvent,
} from "./sdk.js";

const DEFAULT_HOOK_PLUGIN_TIMEOUT_MS = 2_000;
const DEFAULT_EVENT_LOG_STRING_LIMIT_CHARS = 8_000;
const MAX_HOOK_PLUGIN_TIMEOUT_MS = 60_000;
const MAX_EVENT_LOG_STRING_LIMIT_CHARS = 64_000;
const EVENT_LOG_MAX_DEPTH = 6;
const EVENT_LOG_MAX_ARRAY_ITEMS = 100;
const EVENT_LOG_MAX_OBJECT_ENTRIES = 100;
const EVENT_LOG_KEY_LIMIT_CHARS = 160;
const HOOK_PLUGIN_NAME_PREVIEW_CHARS = 120;
const HOOK_EVENT_NAME_PREVIEW_CHARS = 120;
const HOOK_OUTPUT_STRING_LIMIT_CHARS = 4_000;

let pluginsCache: { cwd: string; plugins: DarwinPlugin[] } | null = null;

export interface DispatchOptions {
  eventLogStringLimitRaw?: string;
  pluginTimeoutMsRaw?: string;
}

async function getPlugins(cwd: string): Promise<DarwinPlugin[]> {
  const root = resolve(cwd);
  if (pluginsCache === null || pluginsCache.cwd !== root) {
    pluginsCache = { cwd: root, plugins: await loadPlugins(root) };
  }
  return pluginsCache.plugins;
}

function logEvent(
  cwd: string,
  event: string,
  payload: HookPayload,
  stringLimit: number,
): void {
  const path = resolve(cwd, DARWIN_DIR, EVENTS_LOG);
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    t: new Date().toISOString(),
    event: formatHookEventName(event),
    ...sanitizeEventPayload(payload, stringLimit),
  };
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/**
 * Single fan-out point. Always logs (built-in observer), then invokes
 * each loaded plugin's matching handler. Plugin failures are isolated.
 */
export async function dispatch(
  event: LifecycleEvent,
  payload: HookPayload,
  options: DispatchOptions = {},
): Promise<HookHandlerOutput> {
  const cwd = process.cwd();
  const outputs: HookHandlerOutput[] = [];
  try {
    logEvent(
      cwd,
      event,
      payload,
      eventLogStringLimit(options.eventLogStringLimitRaw),
    );
  } catch (err) {
    writeTerminalError(`darwin: event log failed (${formatErrorSummary(err)}); continuing`);
  }

  const plugins = await getPlugins(cwd);
  const timeoutMs = hookPluginTimeoutMs(options.pluginTimeoutMsRaw);
  for (const p of plugins) {
    const h = p.handlers[event];
    if (!h) continue;
    try {
      const output = await runWithTimeout(h, payload, timeoutMs);
      if (output !== undefined) outputs.push(output);
    } catch (err) {
      writeTerminalError(
        `darwin: plugin ${formatHookPluginName(p.name)} ${formatHookEventName(event)} failed: ${formatErrorSummary(err)}`,
      );
    }
  }

  return selectHookOutput(event, outputs);
}

function selectHookOutput(
  event: LifecycleEvent,
  outputs: HookHandlerOutput[],
): HookHandlerOutput {
  const normalized = outputs
    .map((output) => normalizeHookOutput(event, output))
    .filter((output): output is string | Record<string, unknown> => output !== undefined);
  for (const output of normalized) {
    if (typeof output === "object" && isBlockingHookOutput(output)) return output;
  }
  return normalized[0];
}

function normalizeHookOutput(
  event: LifecycleEvent,
  output: HookHandlerOutput,
): HookHandlerOutput {
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return undefined;
    // Codex requires JSON stdout for Stop. Treat a string from a Darwin plugin
    // as an intentional continuation prompt rather than invalid plain text.
    if (event === "stop") {
      return { decision: "block", reason: formatHookOutputString(trimmed) };
    }
    const bounded = formatHookOutputString(output);
    return bounded.endsWith("\n") ? bounded : `${bounded}\n`;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return sanitizeHookOutputObject(output);
  }
  return undefined;
}

function isBlockingHookOutput(output: Record<string, unknown>): boolean {
  return output.decision === "block" || output.continue === false;
}

function formatHookPluginName(name: unknown): string {
  return formatErrorSummary(name, HOOK_PLUGIN_NAME_PREVIEW_CHARS);
}

function formatHookEventName(name: unknown): string {
  return formatErrorSummary(name, HOOK_EVENT_NAME_PREVIEW_CHARS);
}

function hookPluginTimeoutMs(raw = process.env.DARWIN_HOOK_PLUGIN_TIMEOUT_MS): number {
  return resolveHookPluginTimeoutMs(raw);
}

function eventLogStringLimit(raw = process.env.DARWIN_EVENT_LOG_STRING_LIMIT_CHARS): number {
  return resolveEventLogStringLimit(raw);
}

export function resolveHookPluginTimeoutMs(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_HOOK_PLUGIN_TIMEOUT_MS, MAX_HOOK_PLUGIN_TIMEOUT_MS);
}

export function resolveEventLogStringLimit(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_EVENT_LOG_STRING_LIMIT_CHARS, MAX_EVENT_LOG_STRING_LIMIT_CHARS);
}

function sanitizeEventPayload(
  payload: HookPayload,
  stringLimit: number,
): HookPayload {
  const seen = new WeakSet<object>();
  return sanitizeValue(payload, stringLimit, 0, seen) as HookPayload;
}

function sanitizeValue(
  value: unknown,
  stringLimit: number,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    return `${value.slice(0, stringLimit)}...[truncated ${value.length - stringLimit} chars]`;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return String(value);
  if (depth >= EVENT_LOG_MAX_DEPTH) return "[depth limit]";
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, EVENT_LOG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, stringLimit, depth + 1, seen));
    if (value.length > EVENT_LOG_MAX_ARRAY_ITEMS) {
      items.push(`...[truncated ${value.length - EVENT_LOG_MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entry] of entries.slice(0, EVENT_LOG_MAX_OBJECT_ENTRIES)) {
    out[sanitizeEventKey(key)] = sanitizeValue(entry, stringLimit, depth + 1, seen);
  }
  if (entries.length > EVENT_LOG_MAX_OBJECT_ENTRIES) {
    out.__darwin_truncated_entries = entries.length - EVENT_LOG_MAX_OBJECT_ENTRIES;
  }
  return out;
}

function sanitizeEventKey(key: string): string {
  const normalized = key.replace(/\s+/g, " ");
  if (normalized.length <= EVENT_LOG_KEY_LIMIT_CHARS) return normalized;
  return `${normalized.slice(0, EVENT_LOG_KEY_LIMIT_CHARS - 3)}...`;
}

function sanitizeHookOutputObject(output: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return sanitizeValue(output, HOOK_OUTPUT_STRING_LIMIT_CHARS, 0, seen) as Record<string, unknown>;
}

function formatHookOutputString(value: string): string {
  if (value.length <= HOOK_OUTPUT_STRING_LIMIT_CHARS) return value;
  return `${value.slice(0, HOOK_OUTPUT_STRING_LIMIT_CHARS)}...[truncated ${value.length - HOOK_OUTPUT_STRING_LIMIT_CHARS} chars]`;
}

async function runWithTimeout(
  handler: HookHandler,
  payload: HookPayload,
  timeoutMs: number,
): Promise<HookHandlerOutput> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => handler(payload)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${formatDurationMs(timeoutMs)}`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
