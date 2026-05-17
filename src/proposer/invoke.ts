import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  engineCommand,
  engineEnv,
  type EngineName,
} from "../runtime/engine.js";

/**
 * Spawn the selected engine interactively with the proposer prompt as the initial
 * input. stdio is inherited so the user watches the proposer work.
 *
 * Expects the proposer to write a single file at `expectedOutputPath`
 * before exiting. Returns when the engine exits successfully and the file
 * exists; rejects otherwise.
 */
export async function invokeProposer(
  promptText: string,
  expectedOutputPath: string,
  engine: EngineName = "codex",
  engineArgs: string[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(engineCommand(engine), [...engineArgs, promptText], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: engineEnv(engine),
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`${engineCommand(engine)} exited with code ${code}`),
        );
      }
      if (!existsSync(expectedOutputPath)) {
        return reject(
          new Error(`proposer did not write ${expectedOutputPath}`),
        );
      }
      resolve();
    });
  });
}
