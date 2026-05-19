import type { ScorerSpec } from "../spec/parse.js";
import type { ScoreResult } from "./types.js";
import {
  formatExit,
  formatParseBufferNote,
  parseCommandScore,
  runScorerCommand,
  type ScorerCommandOptions,
} from "./command.js";

export async function testSuiteScorer(
  spec: ScorerSpec,
  runDir: string,
  options: ScorerCommandOptions = {},
): Promise<ScoreResult> {
  if (!spec.command?.trim()) {
    return { score: null, note: "test-suite scorer has no command configured" };
  }

  const result = await runScorerCommand(spec.command, runDir, "test-suite", options);
  const parseRule = spec.parse?.trim();
  if (parseRule) {
    const parsed = parseCommandScore(result, parseRule);
    return {
      score: parsed,
      note: parsed === null
        ? `test-suite scorer could not parse a numeric score (${formatExit(result)}${formatParseBufferNote(result)})`
        : `test-suite scorer parsed score ${parsed} (${formatExit(result)})`,
    };
  }

  const passed = result.code === 0 && result.signal === null;
  return {
    score: passed ? 1 : 0,
    note: `test-suite scorer ${passed ? "passed" : "failed"} (${formatExit(result)}; pass=1 fail=0)`,
  };
}
