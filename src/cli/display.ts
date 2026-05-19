import {
  DEFAULT_TERMINAL_FIELD_PREVIEW_CHARS,
  formatErrorSummary,
} from "../runtime/diagnostics.js";
import {
  writeTerminalError,
  writeTerminalOutput,
} from "../runtime/terminal.js";

export const CLI_FIELD_PREVIEW_CHARS = DEFAULT_TERMINAL_FIELD_PREVIEW_CHARS;

export function formatCliField(
  value: unknown,
  limit = CLI_FIELD_PREVIEW_CHARS,
): string {
  return formatErrorSummary(value, limit);
}

export function writeCliOutput(value: string): void {
  writeTerminalOutput(value);
}

export function writeCliError(value: string): void {
  writeTerminalError(value);
}
