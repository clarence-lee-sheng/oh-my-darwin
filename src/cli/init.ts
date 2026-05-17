import { runInterview } from "../interview/loop.js";
import type { EngineName } from "../runtime/engine.js";

export async function init(
  engine: EngineName = "codex",
  engineArgs: string[] = [],
): Promise<void> {
  await runInterview(engine, engineArgs);
}
