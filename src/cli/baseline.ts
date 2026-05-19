import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  formatDurationMs,
  formatErrorSummary,
  formatMultilinePreview,
} from "../runtime/diagnostics.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineLabel,
  formatEngineCommandForLog,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { readSpec } from "../spec/parse.js";
import {
  BASELINE_RUN_ID,
  DARWIN_DIR,
  RUNS_DIR,
} from "./constants.js";
import { writeCliError } from "./display.js";

const BASELINE_TASK_PREVIEW_CHARS = 2_000;
const BASELINE_COMMAND_PREVIEW_CHARS = 240;

/**
 * Run the task described in .darwin/meta-spec.md once, no proposer
 * in play, to establish a starting score. Spawns the selected agent
 * with the task as the initial prompt; on agent exit, dispatches to
 * the scorer declared in the spec; writes frontier.json + one
 * evolution row + a runs/baseline/ directory.
 */
export async function baseline(
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  const cwd = process.cwd();
  const spec = readSpec(cwd);
  if (!spec.task) {
    throw new Error(
      "meta-spec.md is missing a `## Task` section - re-run `darwin init` or edit the spec.",
    );
  }

  const runDir = join(cwd, DARWIN_DIR, RUNS_DIR, BASELINE_RUN_ID);
  const runDirRel = `${RUNS_DIR}/${BASELINE_RUN_ID}`;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "task.md"), spec.task + "\n");

  writeCliError(`darwin: baseline run for "${formatBaselineField(spec.slug || "(unnamed)")}"`);
  writeCliError(
    `darwin: task preview:\n  ${formatTaskPreview(spec.task, runDirRel)}\n\n`,
  );
  writeCliError(`darwin: scorer source = ${formatBaselineField(spec.scorer.source)}`);
  writeCliError(
    `darwin: launching ${formatBaselineEngineCommand(engine, engineArgs)} (${engineLabel(engine)}, interactive)`,
  );

  const startedAt = Date.now();
  const { spawnEngine } = await import("../runtime/bridge.js");
  const { exitInfo } = spawnEngine(engine, [spec.task], { engineArgs });
  const { engine: completedEngine, code: exitCode } = await exitInfo;
  const endedAt = Date.now();

  writeCliError(
    `\ndarwin: ${engineCommand(completedEngine)} exited (code ${exitCode}, ${formatDurationMs(endedAt - startedAt)})`,
  );

  // Dispatch to the spec-declared scorer.
  const { scoreRun } = await import("../scorer/index.js");
  const { score, note } = await scoreRun(spec.scorer, runDir);

  const t = new Date().toISOString();
  const outcome = score === null ? "skipped" : "scored";

  const [{ appendEvolution }, { writeFrontier }] = await Promise.all([
    import("../state/history.js"),
    import("../state/frontier.js"),
  ]);
  appendEvolution(
    {
      t,
      attempt_id: BASELINE_RUN_ID,
      score,
      outcome,
      note,
      run_dir: runDirRel,
    },
    cwd,
  );

  writeFrontier(
    {
      attempt_id: BASELINE_RUN_ID,
      score,
      t,
      note,
      run_dir: runDirRel,
    },
    cwd,
  );

  writeCliError(
    `darwin: wrote frontier.json (score=${score ?? "null"}) and appended evolution.jsonl`,
  );
  if (score === null) {
    writeCliError(
      "darwin: no score recorded; later `darwin meta` will treat this baseline as unscored.",
    );
  }
}

export function formatTaskPreview(
  task: string,
  runDirRel = `${RUNS_DIR}/${BASELINE_RUN_ID}`,
): string {
  return formatMultilinePreview(task, {
    limit: BASELINE_TASK_PREVIEW_CHARS,
    indent: "  ",
    truncatedSuffix: `...[truncated; full task saved to ${DARWIN_DIR}/${runDirRel}/task.md]`,
  });
}

export function formatBaselineField(value: unknown): string {
  return formatErrorSummary(value);
}

export function formatBaselineEngineCommand(
  engine: EngineName,
  engineArgs: string[] = resolveEngineArgs(engine),
): string {
  return formatErrorSummary(
    formatEngineCommandForLog(engine, engineArgs),
    BASELINE_COMMAND_PREVIEW_CHARS,
  );
}
