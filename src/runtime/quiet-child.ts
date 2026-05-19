import { spawn } from "node:child_process";
import { formatDurationMs, keepTail } from "./diagnostics.js";
import { terminateProcessTree } from "./process-tree.js";

export interface QuietChildResult {
  code: number;
  timedOut: boolean;
  stderrTail: string;
}

export interface QuietChildOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  timeoutLabel: string;
  writeStatus?: (message: string) => void;
  killGraceMs?: number;
}

export function formatQuietChildStderrTail(
  label: string,
  stderrTail: string,
): string {
  if (!stderrTail.trim()) return "";
  return `darwin: ${label} stderr tail (${stderrTail.length} chars)\n${stderrTail.trimEnd()}\n`;
}

export function runQuietChild(opts: QuietChildOptions): Promise<QuietChildResult> {
  let stderrTail = "";
  let timedOut = false;
  const killGraceMs = opts.killGraceMs ?? 2_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== "win32",
    });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = keepTail(stderrTail + chunk.toString());
    });
    child.stdin?.end(opts.input);

    timer = setTimeout(() => {
      timedOut = true;
      opts.writeStatus?.(
        `darwin: ${opts.timeoutLabel} timed out after ${formatDurationMs(opts.timeoutMs)} - terminating ${opts.command} exec\n`,
      );
      terminateProcessTree(child.pid, "SIGTERM", child.kill.bind(child));
      killTimer = setTimeout(() => {
        terminateProcessTree(child.pid, "SIGKILL", child.kill.bind(child));
      }, killGraceMs);
    }, opts.timeoutMs);

    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => resolve({
        code: timedOut ? 124 : code ?? 1,
        timedOut,
        stderrTail,
      }));
    });
  });
}
