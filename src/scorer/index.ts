import { stderr } from "node:process";
import type { ScorerSpec } from "../spec/parse.js";
import { humanScorer } from "./human.js";
import { commandScorer } from "./command.js";
import type { ScoreResult } from "./types.js";

export type { ScoreResult } from "./types.js";

/**
 * Dispatch to the scorer declared in meta-spec.md.
 *
 * Defensive defaults:
 * - If the spec section was absent (`is_default: true`), warn once that
 *   nothing was declared and use the human scorer.
 * - If an automated scorer isn't implemented yet, warn loudly and fall
 *   through to the human scorer for this run.
 * - If an implemented scorer throws or returns garbage, log and fall
 *   through to the human scorer for this run.
 *
 * The fallback chain never crashes the loop; the worst case is asking
 * the user to type a number.
 */
export async function scoreRun(
  scorerSpec: ScorerSpec,
  runDir: string,
): Promise<ScoreResult> {
  if (scorerSpec.is_default) {
    stderr.write(
      "darwin: no `## Scorer` section in meta-spec.md; falling back to human prompt.\n",
    );
    return humanScorer(scorerSpec);
  }

  try {
    switch (scorerSpec.source) {
      case "human":
        return await humanScorer(scorerSpec);

      case "command":
        return await commandScorer(scorerSpec, runDir);

      case "test-suite":
      case "llm-judge":
        stderr.write(
          `darwin: scorer '${scorerSpec.source}' is not yet implemented — falling back to human prompt.\n`,
        );
        stderr.write(
          "darwin: edit .darwin/meta-spec.md to change scorer source, or upgrade darwin when this adapter ships.\n",
        );
        return await humanScorer(scorerSpec);

      default:
        stderr.write(
          `darwin: unknown scorer source '${scorerSpec.source}' — falling back to human prompt.\n`,
        );
        return await humanScorer(scorerSpec);
    }
  } catch (e) {
    stderr.write(
      `darwin: scorer '${scorerSpec.source}' failed (${e}); falling back to human prompt.\n`,
    );
    return humanScorer(scorerSpec);
  }
}
