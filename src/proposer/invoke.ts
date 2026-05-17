import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Spawn `codex` interactively with the proposer prompt as the initial
 * input. stdio is inherited so the user watches the proposer work.
 *
 * Expects the proposer to write a single file at `expectedOutputPath`
 * before exiting. Returns when codex exits successfully and the file
 * exists; rejects otherwise.
 */
export async function invokeProposer(
  promptText: string,
  expectedOutputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", [promptText], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error(`codex exited with code ${code}`));
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
