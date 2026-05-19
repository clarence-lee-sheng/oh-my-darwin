import { formatErrorSummary } from "../runtime/diagnostics.js";
import { writeTerminalError } from "../runtime/terminal.js";
import type { ScorerSpec } from "../spec/parse.js";
import type { ScorerCommandOptions } from "./command.js";
import type { ScoreResult } from "./types.js";

export type { ScoreResult } from "./types.js";

const SCORER_SOURCE_SUMMARY_LIMIT = 120;

function formatScorerSource(source: unknown): string {
  return formatErrorSummary(source, SCORER_SOURCE_SUMMARY_LIMIT);
}

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
  options: ScorerCommandOptions = {},
): Promise<ScoreResult> {
  if (scorerSpec.is_default) {
    writeTerminalError(
      "darwin: no `## Scorer` section in meta-spec.md; falling back to human prompt.",
    );
    return runHumanScorer(scorerSpec);
  }

  try {
    switch (scorerSpec.source) {
      case "human":
        return await runHumanScorer(scorerSpec);

      case "command":
        return await runCommandScorer(scorerSpec, runDir, options);

      case "test-suite":
        return await runTestSuiteScorer(scorerSpec, runDir, options);

      case "llm-judge":
        writeTerminalError(
          "darwin: scorer 'llm-judge' is not yet implemented; not falling back to human verification.",
        );
        return {
          score: null,
          note: "llm-judge scorer is not implemented yet",
        };

      default: {
        const source = formatScorerSource(scorerSpec.source);
        writeTerminalError(
          `darwin: unknown scorer source '${source}'; not falling back to human verification.`,
        );
        return {
          score: null,
          note: `unknown scorer source: ${source}`,
        };
      }
    }
  } catch (e) {
    const source = formatScorerSource(scorerSpec.source);
    const message = formatErrorSummary(e);
    writeTerminalError(
      `darwin: scorer '${source}' failed (${message}); recording a skipped score.`,
    );
    return {
      score: null,
      note: `scorer '${source}' failed: ${message}`,
    };
  }
}

async function runHumanScorer(scorerSpec: ScorerSpec): Promise<ScoreResult> {
  const { humanScorer } = await import("./human.js");
  return humanScorer(scorerSpec);
}

async function runCommandScorer(
  scorerSpec: ScorerSpec,
  runDir: string,
  options: ScorerCommandOptions,
): Promise<ScoreResult> {
  const { commandScorer } = await import("./command.js");
  return commandScorer(scorerSpec, runDir, options);
}

async function runTestSuiteScorer(
  scorerSpec: ScorerSpec,
  runDir: string,
  options: ScorerCommandOptions,
): Promise<ScoreResult> {
  const { testSuiteScorer } = await import("./suite.js");
  return testSuiteScorer(scorerSpec, runDir, options);
}
