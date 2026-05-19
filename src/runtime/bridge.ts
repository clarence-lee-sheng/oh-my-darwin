import { spawn, type ChildProcess } from "node:child_process";
import {
  engineCommand,
  engineEnv,
  fallbackEngine,
  fallbackNotice,
  isEngineLaunchError,
  resolveEngineArgs,
  type EngineName,
} from "./engine.js";
import { writeTerminalError } from "./terminal.js";

export interface SpawnResult {
  child: ChildProcess;
  exit: Promise<number>;
  exitInfo: Promise<{ engine: EngineName; code: number }>;
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
  const exitInfo = new Promise<{ engine: EngineName; code: number }>((resolve, reject) => {
    child.once("error", (err) => {
      const fallback = fallbackEngine(engine);
      if (fallback && isEngineLaunchError(err)) {
        writeTerminalError(fallbackNotice(engine, fallback, err));
        spawnEngine(fallback, args, {
          cwd: options.cwd,
          engineArgs: resolveEngineArgs(fallback),
        }).exitInfo.then(
          resolve,
          reject,
        );
        return;
      }
      reject(err);
    });
    child.once("exit", (code, signal) => {
      resolve({ engine, code: code ?? signalExitCode(signal) });
    });
  });
  const exit = exitInfo.then((info) => info.code, () => 1);
  return { child, exit, exitInfo };
}

/** Backward-compatible helper for the original Codex-only call sites. */
export function spawnCodex(args: string[]): SpawnResult {
  return spawnEngine("codex", args);
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 1 : 0;
}
