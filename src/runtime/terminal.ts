export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function writeTerminalStream(stream: NodeJS.WritableStream, value: string): void {
  if (value.length === 0) return;
  stream.write(ensureTrailingNewline(value));
}

export function writeTerminalError(value: string): void {
  writeTerminalStream(process.stderr, value);
}

export function writeTerminalOutput(value: string): void {
  writeTerminalStream(process.stdout, value);
}
