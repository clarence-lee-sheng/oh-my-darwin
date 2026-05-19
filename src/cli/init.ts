import { selectProjectForInit } from "../projects/selection.js";
import {
  DEFAULT_ENGINE,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { writeCliError } from "./display.js";
import { ensureAgents } from "./setup.js";

export async function init(
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  if (ensureAgents()) {
    writeCliError("darwin: installed .agents");
  }

  await selectProjectForInit();
  const { runInterview } = await import("../interview/loop.js");
  await runInterview(engine, engineArgs);
}
