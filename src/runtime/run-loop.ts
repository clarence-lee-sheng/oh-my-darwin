import { spawnEngine } from "./bridge.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  resolveEngineArgs,
  type EngineName,
} from "./engine.js";
import { dispatch } from "../hooks/extensibility/dispatcher.js";
import { formatErrorSummary } from "./diagnostics.js";
import { writeTerminalError } from "./terminal.js";

/**
 * Owns the agent child's lifecycle. v0: dispatch run_start, spawn,
 * dispatch run_end with the exit code. Future: retry, model swap,
 * multi-harness routing all hook in here.
 */
export async function runEngine(
  args: string[],
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<number> {
  const started = Date.now();
  await dispatch("run_start", { engine, engine_args: engineArgs, args, started });

  try {
    const { exitInfo } = spawnEngine(engine, args, { engineArgs });
    const { engine: completedEngine, code } = await exitInfo;

    await dispatch("run_end", {
      engine,
      actual_engine: completedEngine,
      engine_args: engineArgs,
      args,
      started,
      ended: Date.now(),
      exit_code: code,
    });
    return code;
  } catch (err) {
    const message = formatErrorSummary(err);
    writeTerminalError(`darwin: ${engineCommand(engine)} launch failed (${message})`);
    await dispatch("run_end", {
      engine,
      engine_args: engineArgs,
      args,
      started,
      ended: Date.now(),
      exit_code: 1,
      error: message,
    });
    return 1;
  }
}

/** Backward-compatible helper for the original Codex-only API. */
export async function runCodex(args: string[]): Promise<number> {
  return runEngine(args, "codex");
}
