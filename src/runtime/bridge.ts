import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnResult {
  child: ChildProcess;
  exit: Promise<number>;
}

/**
 * Spawn the Codex CLI as a child process with stdio inherited from the
 * parent terminal. Centralized so future versions can swap to piped IO
 * (for interception / steering) without touching the run-loop.
 */
export function spawnCodex(args: string[]): SpawnResult {
  const child = spawn("codex", args, { stdio: "inherit" });
  const exit = new Promise<number>((res) => {
    child.on("exit", (code) => res(code ?? 0));
  });
  return { child, exit };
}
