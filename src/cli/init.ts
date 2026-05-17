import { runInterview } from "../interview/loop.js";
import {
  DEFAULT_ENGINE,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";

export async function init(
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  await runInterview(engine, engineArgs);
}
