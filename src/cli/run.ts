import { runCodex } from "../runtime/run-loop.js";

export async function run(args: string[]): Promise<number> {
  return runCodex(args);
}
