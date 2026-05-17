import { runInterview } from "../interview/loop.js";
import { selectProjectForInit } from "../projects/registry.js";

export async function init(): Promise<void> {
  await selectProjectForInit();
  await runInterview();
}
