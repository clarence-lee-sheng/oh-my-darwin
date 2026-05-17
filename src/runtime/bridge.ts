import { spawn, type ChildProcess } from "node:child_process";
import {
  engineCommand,
  engineEnv,
  type EngineName,
} from "./engine.js";

export interface SpawnResult {
  child: ChildProcess;
  exit: Promise<number>;
}

/**
 * Spawn the selected agent CLI as a child process with stdio inherited from
 * the parent terminal. Centralized so future versions can swap to piped IO
 * (for interception / steering) without touching the run-loop.
 */
export function spawnEngine(
  engine: EngineName,
  args: string[],
  options: { cwd?: string; engineArgs?: string[] } = {},
): SpawnResult {
  const child = spawn(engineCommand(engine), [
    ...(options.engineArgs ?? []),
    ...args,
  ], {
    stdio: "inherit",
    cwd: options.cwd,
    env: engineEnv(engine),
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
  return { child, exit };
}

/** Backward-compatible helper for the original Codex-only call sites. */
export function spawnCodex(args: string[]): SpawnResult {
  return spawnEngine("codex", args);
}
