import { spawnEngine } from "./bridge.js";
import type { EngineName } from "./engine.js";
import { dispatch } from "../hooks/extensibility/dispatcher.js";

/**
 * Owns the agent child's lifecycle. v0: dispatch run_start, spawn,
 * dispatch run_end with the exit code. Future: retry, model swap,
 * multi-harness routing all hook in here.
 */
export async function runEngine(
  args: string[],
  engine: EngineName,
  engineArgs: string[] = [],
): Promise<number> {
  const started = Date.now();
  await dispatch("run_start", { engine, engine_args: engineArgs, args, started });

  const { exit } = spawnEngine(engine, args, { engineArgs });
  const code = await exit;

  await dispatch("run_end", {
    engine,
    engine_args: engineArgs,
    args,
    started,
    ended: Date.now(),
    exit_code: code,
  });
  return code;
}

/** Backward-compatible helper for the original Codex-only API. */
export async function runCodex(args: string[]): Promise<number> {
  return runEngine(args, "codex");
}
