import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stderr } from "node:process";
import { spawnCodex } from "../runtime/bridge.js";
import { readSpec } from "../spec/parse.js";
import { scoreRun } from "../scorer/index.js";
import { writeFrontier } from "../state/frontier.js";
import { appendEvolution } from "../state/history.js";
import {
  BASELINE_RUN_ID,
  DARWIN_DIR,
  RUNS_DIR,
} from "./constants.js";

/**
 * Run the task described in .darwin/meta-spec.md once, no proposer
 * in play, to establish a starting score. Spawns Codex interactively
 * with the task as the initial prompt; on Codex exit, dispatches to
 * the scorer declared in the spec; writes frontier.json + one
 * evolution row + a runs/baseline/ directory.
 */
export async function baseline(): Promise<void> {
  const cwd = process.cwd();
  const spec = readSpec(cwd);
  if (!spec.task) {
    throw new Error(
      "meta-spec.md is missing a `## Task` section — re-run `darwin init` or edit the spec.",
    );
  }

  const runDir = join(cwd, DARWIN_DIR, RUNS_DIR, BASELINE_RUN_ID);
  const runDirRel = `${RUNS_DIR}/${BASELINE_RUN_ID}`;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "task.md"), spec.task + "\n");

  stderr.write(`darwin: baseline run for "${spec.slug || "(unnamed)"}"\n`);
  stderr.write(`darwin: task →\n  ${spec.task.split("\n").join("\n  ")}\n\n`);
  stderr.write(`darwin: scorer source = ${spec.scorer.source}\n`);
  stderr.write("darwin: launching codex (interactive)\n");

  const startedAt = Date.now();
  const { exit } = spawnCodex([spec.task]);
  const exitCode = await exit;
  const endedAt = Date.now();

  stderr.write(
    `\ndarwin: codex exited (code ${exitCode}, ${Math.round((endedAt - startedAt) / 1000)}s)\n`,
  );

  // Dispatch to the spec-declared scorer.
  const { score, note } = await scoreRun(spec.scorer, runDir);

  const t = new Date().toISOString();
  const outcome = score === null ? "skipped" : "scored";

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

  stderr.write(
    `darwin: wrote frontier.json (score=${score ?? "null"}) and appended evolution.jsonl\n`,
  );
  if (score === null) {
    stderr.write(
      "darwin: no score recorded; later `darwin meta` will treat this baseline as unscored.\n",
    );
  }
}
