import { runEngine } from "../runtime/run-loop.js";
import type { EngineName } from "../runtime/engine.js";

export async function run(
  args: string[],
  engine: EngineName = "codex",
  engineArgs: string[] = [],
): Promise<number> {
  return runEngine(args, engine, engineArgs);
}
