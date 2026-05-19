import { existsSync } from "node:fs";

export interface WaitForFileOptions {
  pollMs?: number;
  settleMs?: number;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function waitForFile(
  path: string,
  opts: WaitForFileOptions = {},
): Promise<void> {
  if (fileExists(path)) return Promise.resolve();

  const pollMs = opts.pollMs ?? 250;
  const settleMs = opts.settleMs ?? 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fileExists(path)) return;
      clearInterval(timer);
      if (settleMs > 0) setTimeout(resolve, settleMs);
      else resolve();
    }, pollMs);
    timer.unref?.();
  });
}
