import { stderr } from "node:process";
import type { ScorerSpec } from "../spec/parse.js";
import { commandScorer } from "./command.js";
import { humanScorer } from "./human.js";
import { testSuiteScorer } from "./suite.js";
import type { ScoreResult } from "./types.js";

export type { ScoreResult } from "./types.js";

/**
 * Dispatch to the scorer declared in meta-spec.md.
 *
 * Defensive defaults:
 * - If the spec section was absent (`is_default: true`), warn once that
 *   nothing was declared and use the human scorer.
 * - If an automated scorer is selected, do not silently fall through to a
 *   human prompt; a missing/broken adapter returns a null score and note.
 * - If an implemented scorer throws or returns garbage, log and return a
 *   skipped score for this run.
 *
 * The fallback chain never crashes the loop; the worst case is asking
 * the user to type a number only when the spec explicitly requested human
 * scoring or omitted the scorer section.
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
        return await testSuiteScorer(scorerSpec, runDir);

      case "llm-judge":
        stderr.write(
          "darwin: scorer 'llm-judge' is not yet implemented; not falling back to human verification.\n",
        );
        return {
          score: null,
          note: "llm-judge scorer is not implemented yet",
        };

      default:
        stderr.write(
          `darwin: unknown scorer source '${scorerSpec.source}'; not falling back to human verification.\n`,
        );
        return {
          score: null,
          note: `unknown scorer source: ${String(scorerSpec.source)}`,
        };
    }
  } catch (e) {
    stderr.write(
      `darwin: scorer '${scorerSpec.source}' failed (${e}); recording a skipped score.\n`,
    );
    return {
      score: null,
      note: `scorer '${scorerSpec.source}' failed: ${String(e).slice(0, 200)}`,
    };
  }
}
