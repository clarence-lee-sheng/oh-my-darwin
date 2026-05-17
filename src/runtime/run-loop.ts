import { spawnCodex } from "./bridge.js";
import { dispatch } from "../hooks/extensibility/dispatcher.js";

/**
 * Owns the Codex child's lifecycle. v0: dispatch run_start, spawn,
 * dispatch run_end with the exit code. Future: retry, model swap,
 * multi-harness routing all hook in here.
 */
export async function runCodex(args: string[]): Promise<number> {
  const started = Date.now();
  await dispatch("run_start", { args, started });

  const { exit } = spawnCodex(args);
  const code = await exit;

  await dispatch("run_end", {
    args,
    started,
    ended: Date.now(),
    exit_code: code,
  });
  return code;
}
