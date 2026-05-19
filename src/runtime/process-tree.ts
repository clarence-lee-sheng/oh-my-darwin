import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface TerminateChildOptions {
  killGraceMs?: number;
  settleMs?: number;
}

export function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallbackKill: (signal: NodeJS.Signals) => boolean,
): void {
  if (pid && process.platform !== "win32") {
    let signaled = false;

    // Fast path for children spawned with detached:true: the child pid is also
    // the process-group id, so this reaches wrappers plus grandchildren.
    try {
      process.kill(-pid, signal);
      signaled = true;
    } catch {
      // Non-detached interactive children are usually in the parent's process
      // group, so negative-pid signaling can fail. Fall through to a descendant
      // walk instead of only killing the wrapper process.
    }

    for (const childPid of collectDescendants(pid).reverse()) {
      try {
        process.kill(childPid, signal);
        signaled = true;
      } catch {
        /* ignore raced exits */
      }
    }

    try {
      process.kill(pid, signal);
      signaled = true;
    } catch {
      /* ignore raced exits */
    }

    if (signaled) return;
  }

  try {
    fallbackKill(signal);
  } catch {
    try { fallbackKill(signal); } catch { /* ignore */ }
  }
}

export async function terminateChildProcess(
  child: ChildProcess,
  opts: TerminateChildOptions = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const killGraceMs = opts.killGraceMs ?? 5_000;
  const settleMs = opts.settleMs ?? 1_000;

  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      child.off("exit", done);
      resolve();
    };

    child.once("exit", done);
    terminateProcessTree(child.pid, "SIGTERM", child.kill.bind(child));
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }

    killTimer = setTimeout(() => {
      terminateProcessTree(child.pid, "SIGKILL", child.kill.bind(child));
    }, killGraceMs);
    settleTimer = setTimeout(done, killGraceMs + settleMs);
  });
}

function collectDescendants(rootPid: number): number[] {
  const seen = new Set<number>([rootPid]);
  const out: number[] = [];
  const stack = [rootPid];

  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of directChildren(parent)) {
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }

  return out;
}

function directChildren(parentPid: number): number[] {
  try {
    const proc = spawnSync("pgrep", ["-P", String(parentPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (proc.status !== 0 || !proc.stdout.trim()) return [];
    return proc.stdout
      .trim()
      .split(/\s+/)
      .map((raw) => Number.parseInt(raw, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}
