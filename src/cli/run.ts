import { runEngine } from "../runtime/run-loop.js";
import {
  DEFAULT_ENGINE,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";

export async function run(
  args: string[],
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<number> {
  return runEngine(args, engine, engineArgs);
}
