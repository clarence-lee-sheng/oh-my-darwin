import readline from "node:readline/promises";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { spawnEngine } from "../runtime/bridge.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineLabel,
  formatEngineCommand,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { readSpec, type SpecSlice } from "../spec/parse.js";
import { scoreRun } from "../scorer/index.js";
import { readFrontier, writeFrontier } from "../state/frontier.js";
import {
  appendEvolution,
  readLastEvolutionHint,
} from "../state/history.js";
import { loadAndValidate, type Harness } from "../harness/load.js";
import { invokeProposer } from "../proposer/invoke.js";
import { init } from "./init.js";
import { baseline } from "./baseline.js";
import {
  DARWIN_DIR,
  HARNESS_DIR,
  HARNESS_FILE,
  META_SPEC_FILE,
  PROPOSALS_DIR,
  RUNS_DIR,
} from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function baselineHarnessTemplate(): string {
  // dist/cli/meta.js → ../../templates/harness/harness.mjs
  return resolve(__dirname, "..", "..", "templates", "harness", "harness.mjs");
}

function harnessPath(cwd: string): string {
  return join(cwd, DARWIN_DIR, HARNESS_DIR, HARNESS_FILE);
}

function ensureBaselineHarness(cwd: string): void {
  const dst = harnessPath(cwd);
  if (existsSync(dst)) return;
  mkdirSync(dirname(dst), { recursive: true });
  const src = baselineHarnessTemplate();
  if (existsSync(src)) {
    copyFileSync(src, dst);
  } else {
    // Fallback if templates aren't shipped — write a minimal inline baseline.
    writeFileSync(
      dst,
      "export default {\n  buildPrompt: (task) => task,\n};\n",
    );
  }
}

interface LoopOptions {
  /** Max iterations. Infinity = unbounded. */
  maxIterations: number;
  /** Max wall-clock in ms from loop start. Infinity = unbounded. */
  maxDurationMs: number;
  /** Whether to prompt between iterations even when bounded. */
  interactive: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 3;

function parseLoopOptions(args: string[]): LoopOptions {
  let maxIterations = Infinity;
  const iterIdx = args.indexOf("--iterations");
  if (iterIdx !== -1) {
    const n = parseInt(args[iterIdx + 1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) maxIterations = n;
  }

  let maxDurationMs = Infinity;
  const durIdx = args.indexOf("--duration");
  if (durIdx !== -1) {
    const parsed = parseDuration(args[durIdx + 1] ?? "");
    if (parsed !== null) maxDurationMs = parsed;
    else {
      throw new Error(
        `invalid --duration value: ${args[durIdx + 1] ?? ""} (use forms like 90s, 30m, 2h, 1d)`,
      );
    }
  }

  const interactive = args.includes("--interactive");
  return { maxIterations, maxDurationMs, interactive };
}

/**
 * Parse durations like "90s", "30m", "2h", "1d" into milliseconds.
 * Returns null on parse failure.
 */
function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function formatBound(opts: LoopOptions): string {
  const parts: string[] = [];
  if (Number.isFinite(opts.maxIterations)) parts.push(`${opts.maxIterations} iteration(s)`);
  if (Number.isFinite(opts.maxDurationMs)) parts.push(`${formatDuration(opts.maxDurationMs)}`);
  return parts.length === 0 ? "unbounded" : parts.join(" or ");
}

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1_000)}s`;
}

interface ProposerPromptArgs {
  engine: EngineName;
  task: string;
  currentHarness: string;
  frontierAttempt: string;
  frontierScore: number | null;
  priorHint?: string;
  proposalDirRel: string;
  proposalPathRel: string;
}

function buildProposerPrompt(a: ProposerPromptArgs): string {
  const hintBlock = a.priorHint
    ? `\nHINT FROM PRIOR HARNESS:\n${a.priorHint}\n\nYou may follow this hint or ignore it. It is the prior harness's\nsuggestion for where to focus next. If you ignore it, your hypothesis\nshould briefly say why.\n`
    : "\nHINT FROM PRIOR HARNESS:\n(none)\n";

  return `You are darwin's meta-proposer. Your job: write ONE new harness file
that you believe will improve the score on this task.

The harness is an ESM JavaScript module (.mjs) that controls how the task
is presented to ${engineLabel(a.engine)} when the executor runs. The current
harness is shown below.

TASK:
${a.task}

CURRENT FRONTIER:
- attempt_id: ${a.frontierAttempt}
- score: ${a.frontierScore ?? "null"}

CURRENT HARNESS (.darwin/harness/harness.mjs):
\`\`\`javascript
${a.currentHarness}
\`\`\`
${hintBlock}
YOUR ACTIONS:
- Read .darwin/evolution.jsonl and any .darwin/runs/*/ trajectories to
  understand what's been tried and what failed.
- Read .darwin/proposals/iter-*/harness.mjs to see prior candidates.
- Then Write exactly ONE file at: ${a.proposalPathRel}
  The file must default-export an object with a buildPrompt(task) method
  that returns a non-empty string. It is plain ESM JavaScript — no
  TypeScript syntax, no transpile step. Use JSDoc for any type hints.
- Optionally, also export a suggestNextHypothesis() method returning a
  short string that the NEXT iteration's proposer will see as advisory.
- Do not import anything outside Node built-ins.
- Do not call shell, network, or filesystem-write APIs inside your harness.
- Do not modify any other file (no edits to .darwin/harness/, no edits to
  prior runs/proposals).

Write a one-sentence hypothesis at the top of the file as a // comment.

Exit when the file is written.`;
}

export async function meta(
  args: string[],
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  const opts = parseLoopOptions(args);
  const cwd = process.cwd();

  // Pre-flight 1: spec must exist. If missing, ask the user before running init.
  const specPath = join(cwd, DARWIN_DIR, META_SPEC_FILE);
  if (!existsSync(specPath)) {
    const proceed = await promptYesNo(
      "darwin: no meta-spec.md found. Run `darwin init` first? [Y/n] ",
      true,
    );
    if (!proceed) {
      stderr.write("darwin: aborting. Run `darwin init` when ready.\n");
      return;
    }
    await init(engine, engineArgs);
    if (!existsSync(specPath)) {
      throw new Error("init did not produce meta-spec.md; aborting");
    }
  }

  const spec = readSpec(cwd);
  if (!spec.task) {
    throw new Error(
      "meta-spec.md is missing a `## Task` section — re-run `darwin init` or edit the spec.",
    );
  }

  // Pre-flight 2: frontier must exist. If missing, auto-run baseline (no prompt — it's plumbing).
  let front = readFrontier(cwd);
  if (!front) {
    stderr.write("darwin: no frontier found, running baseline first\n");
    await baseline(engine, engineArgs);
    front = readFrontier(cwd);
    if (!front) {
      throw new Error("baseline did not produce a frontier; aborting");
    }
  }

  ensureBaselineHarness(cwd);

  stderr.write(
    `darwin: meta loop for "${spec.slug || "(unnamed)"}" — ${formatBound(opts)}\n`,
  );
  stderr.write(
    `darwin: current frontier: ${front.attempt_id} (score=${front.score ?? "null"})\n`,
  );

  // The between-iteration prompt fires when the run is unbounded OR when
  // --interactive is set. Bounded runs are silent by default.
  const unbounded = !Number.isFinite(opts.maxIterations) && !Number.isFinite(opts.maxDurationMs);
  const promptBetween = unbounded || opts.interactive;

  const startedAt = Date.now();
  let i = 0;
  let consecutiveFailures = 0;

  while (true) {
    i++;

    // Stop: max iterations
    if (i > opts.maxIterations) {
      stderr.write(`\ndarwin: reached --iterations cap (${opts.maxIterations})\n`);
      break;
    }
    // Stop: max duration
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= opts.maxDurationMs) {
      stderr.write(`\ndarwin: reached --duration cap (${formatDuration(opts.maxDurationMs)} elapsed)\n`);
      break;
    }

    const label = Number.isFinite(opts.maxIterations) ? `${i}/${opts.maxIterations}` : `${i}`;
    stderr.write(`\n=== iteration ${label} ===\n`);

    const outcome = await runIteration(i, cwd, spec, engine, engineArgs);

    // Stop: too many consecutive validation failures
    if (outcome === "rejected" || outcome === "failed") {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stderr.write(
          `\ndarwin: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — proposer appears stuck. Stopping.\n`,
        );
        break;
      }
    } else {
      consecutiveFailures = 0;
    }

    // Between-iteration prompt (only when configured)
    if (promptBetween) {
      const cont = await promptYesNo(
        "\ncontinue? [Y/stop] ",
        true,
      );
      if (!cont) {
        stderr.write(`darwin: stopped by user after ${i} iteration(s)\n`);
        break;
      }
    }
  }

  const finalFront = readFrontier(cwd);
  if (finalFront) {
    stderr.write(
      `\ndarwin: loop complete. final frontier: ${finalFront.attempt_id} (score=${finalFront.score ?? "null"})\n`,
    );
  }
}

type IterationOutcome = "scored" | "skipped" | "failed" | "rejected";

async function runIteration(
  i: number,
  cwd: string,
  spec: SpecSlice,
  engine: EngineName,
  engineArgs: string[],
): Promise<IterationOutcome> {
  const task = spec.task;
  const attemptId = `iter-${i}`;
  const proposalDir = join(cwd, DARWIN_DIR, PROPOSALS_DIR, attemptId);
  const proposalDirRel = `${PROPOSALS_DIR}/${attemptId}`;
  const proposalHarness = join(proposalDir, HARNESS_FILE);
  const proposalHarnessRel = `${DARWIN_DIR}/${proposalDirRel}/${HARNESS_FILE}`;
  mkdirSync(proposalDir, { recursive: true });

  const front = readFrontier(cwd)!;
  const currentHarness = readFileSync(harnessPath(cwd), "utf-8");
  const priorHint = readLastEvolutionHint(cwd);

  const proposerPrompt = buildProposerPrompt({
    engine,
    task,
    currentHarness,
    frontierAttempt: front.attempt_id,
    frontierScore: front.score,
    priorHint,
    proposalDirRel,
    proposalPathRel: proposalHarnessRel,
  });

  // 1. Propose
  stderr.write(`darwin: invoking proposer (${formatEngineCommand(engine, engineArgs)})...\n`);
  try {
    await invokeProposer(proposerPrompt, proposalHarness, engine, engineArgs);
  } catch (e) {
    stderr.write(`darwin: proposer failed: ${e}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `proposer error: ${String(e).slice(0, 200)}`,
      },
      cwd,
    );
    return "failed";
  }

  // 2. Validate
  let harness: Harness;
  try {
    harness = await loadAndValidate(proposalHarness);
  } catch (e) {
    stderr.write(`darwin: candidate ${attemptId} rejected (${e})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `validation: ${String(e).slice(0, 200)}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }
  stderr.write("darwin: candidate validated\n");

  // 3. Execute
  const runDir = join(cwd, DARWIN_DIR, RUNS_DIR, attemptId);
  const runDirRel = `${RUNS_DIR}/${attemptId}`;
  mkdirSync(runDir, { recursive: true });
  copyFileSync(proposalHarness, join(runDir, HARNESS_FILE));

  const prompt = harness.buildPrompt(task);
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  writeFileSync(join(runDir, "task.md"), task + "\n");

  stderr.write(
    `darwin: launching ${formatEngineCommand(engine, engineArgs)} (${engineLabel(engine)}, interactive) with candidate harness\n`,
  );
  const startedAt = Date.now();
  const { exitInfo } = spawnEngine(engine, [prompt], { engineArgs });
  const { engine: completedEngine, code: exitCode } = await exitInfo;
  const endedAt = Date.now();
  stderr.write(
    `darwin: ${engineCommand(completedEngine)} exited (code ${exitCode}, ${Math.round((endedAt - startedAt) / 1000)}s)\n`,
  );

  // 4. Score (dispatched per meta-spec.md's `## Scorer` section)
  const { score, note } = await scoreRun(spec.scorer, runDir);

  // 5. Hint from this harness for the next iteration
  let nextHint: string | undefined;
  if (typeof harness.suggestNextHypothesis === "function") {
    try {
      const h = harness.suggestNextHypothesis();
      if (typeof h === "string" && h.trim().length > 0) {
        nextHint = h.trim();
      }
    } catch {
      /* advisory only — ignore */
    }
  }

  // 6. Record
  const t = new Date().toISOString();
  const outcome = score === null ? "skipped" : "scored";
  const front2 = readFrontier(cwd)!;
  const delta = score !== null && front2.score !== null ? score - front2.score : undefined;

  appendEvolution(
    {
      t,
      attempt_id: attemptId,
      score,
      outcome,
      note,
      run_dir: runDirRel,
      delta,
      next_hint: nextHint,
    },
    cwd,
  );

  // 7. Promote if improved
  if (score !== null && isImproved(score, front2.score, spec)) {
    copyFileSync(proposalHarness, harnessPath(cwd));
    writeFrontier(
      { attempt_id: attemptId, score, t, note, run_dir: runDirRel },
      cwd,
    );
    stderr.write(
      `darwin: new frontier ${attemptId} (score ${score}${delta !== undefined ? `, Δ ${delta >= 0 ? "+" : ""}${delta}` : ""})\n`,
    );
  } else if (score !== null) {
    stderr.write(
      `darwin: ${attemptId} did not improve frontier (${score} vs ${front2.score})\n`,
    );
  }

  return outcome as IterationOutcome;
}

function isImproved(
  score: number,
  frontierScore: number | null,
  spec: SpecSlice,
): boolean {
  if (frontierScore === null) return true;
  return spec.scorer.direction === "lower_is_better"
    ? score < frontierScore
    : score > frontierScore;
}

/**
 * Minimal yes/no prompt. `defaultYes` controls whether bare-enter means
 * "yes" or "no". Accepts y/yes/Y for yes, n/no/N for no, anything else
 * counts as the default.
 */
async function promptYesNo(message: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const raw = (await rl.question(message)).trim().toLowerCase();
    if (raw === "") return defaultYes;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}
