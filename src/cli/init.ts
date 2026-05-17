import { stderr } from "node:process";
import { runInterview } from "../interview/loop.js";
import { selectProjectForInit } from "../projects/registry.js";
import {
  DEFAULT_ENGINE,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { ensureAgents } from "./setup.js";

export async function init(
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  if (ensureAgents()) {
    stderr.write("darwin: installed .agents\n");
  }

  await selectProjectForInit();
  await runInterview(engine, engineArgs);
}
