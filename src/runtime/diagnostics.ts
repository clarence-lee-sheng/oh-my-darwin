import { basename, dirname, isAbsolute, relative } from "node:path";

export const DEFAULT_STDERR_TAIL_LIMIT = 4_000;
export const DEFAULT_TERMINAL_FIELD_PREVIEW_CHARS = 160;
export const DEFAULT_TERMINAL_PATH_PREVIEW_CHARS = DEFAULT_TERMINAL_FIELD_PREVIEW_CHARS;

export function keepTail(value: string, limit = DEFAULT_STDERR_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(-limit) : value;
}

export interface BoundedOutputCapture {
  head: string;
  tail: string;
  totalChars: number;
  truncated: boolean;
}

export function createBoundedOutputCapture(): BoundedOutputCapture {
  return { head: "", tail: "", totalChars: 0, truncated: false };
}

export function captureBoundedOutput(
  capture: BoundedOutputCapture,
  chunk: string,
  limit: number,
): void {
  const boundedLimit = Math.max(0, limit);
  capture.totalChars += chunk.length;
  const remainingHead = boundedLimit - capture.head.length;
  if (remainingHead > 0) {
    capture.head += chunk.slice(0, remainingHead);
  }
  capture.tail = boundedLimit > 0
    ? (capture.tail + chunk).slice(-boundedLimit)
    : "";
  capture.truncated = capture.totalChars > boundedLimit;
}

export function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const parsed = parsePositiveInt(raw);
  if (parsed === null) return fallback;
  return Math.min(parsed, max);
}

export function formatDurationMs(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return safeMs < 1_000 ? "<1s" : `${Math.round(safeMs / 1000)}s`;
}

export function formatErrorSummary(
  err: unknown,
  limit = DEFAULT_TERMINAL_FIELD_PREVIEW_CHARS,
): string {
  return truncatePreview(String(err).replace(/\s+/g, " "), limit);
}

export interface TerminalPathOptions {
  cwd?: string;
  limit?: number;
}

export function formatPathForTerminal(
  filePath: string,
  opts: TerminalPathOptions = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  const limit = opts.limit ?? DEFAULT_TERMINAL_PATH_PREVIEW_CHARS;
  const rel = relative(cwd, filePath);
  const display = rel && !rel.startsWith("..") && !isAbsolute(rel)
    ? rel
    : formatExternalPathForTerminal(filePath);
  return formatErrorSummary(display, limit);
}

function formatExternalPathForTerminal(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const file = formatErrorSummary(basename(filePath) || filePath, 80);
  const parent = formatErrorSummary(basename(dirname(filePath)), 120);
  return `<external>/${parent ? `${parent}/` : ""}${file}`;
}

function truncatePreview(value: string, limit: number): string {
  const boundedLimit = Math.max(0, limit);
  if (value.length <= boundedLimit) return value;
  if (boundedLimit <= 3) return value.slice(0, boundedLimit);
  return `${value.slice(0, boundedLimit - 3)}...`;
}

export interface MultilinePreviewOptions {
  limit?: number;
  indent?: string;
  truncatedSuffix?: string;
}

export function formatMultilinePreview(
  value: string,
  opts: MultilinePreviewOptions = {},
): string {
  const limit = Math.max(0, opts.limit ?? 2_000);
  const indent = opts.indent ?? "  ";
  const trimmed = value.trimEnd();
  const truncated = trimmed.length > limit;
  const body = truncated ? trimmed.slice(0, limit).trimEnd() : trimmed;
  const preview = body.split("\n").join(`\n${indent}`);

  if (!truncated) return preview;
  const suffix = opts.truncatedSuffix ?? "...[truncated]";
  return preview ? `${preview}\n${indent}${suffix}` : suffix;
}
