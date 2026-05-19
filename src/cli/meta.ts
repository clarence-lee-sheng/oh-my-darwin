import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  formatDurationMs,
  formatErrorSummary,
  formatMultilinePreview,
} from "../runtime/diagnostics.js";
import type { GoalRunner } from "../runtime/goal-attempt.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineLabel,
  formatEngineCommandForLog,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { readSpec, type SpecSlice } from "../spec/parse.js";
import { readFrontier, writeFrontier } from "../state/frontier.js";
import {
  appendEvolution,
  readLastEvolutionHint,
  readRecentEvolution,
} from "../state/history.js";
import type { Harness } from "../harness/load.js";
import {
  resolveProposerRunner,
  type ProposerRunner,
} from "../proposer/runner.js";
import { resolveCurrentProject } from "../projects/registry.js";
import type { ValidatedCapabilityBundle } from "../capabilities/manifest.js";
import type { GoalCandidate } from "../proposer/goal-proposer.js";
import type {
  ParentAttempt,
  Population,
  StrategyContext,
} from "../strategy/contract.js";
import {
  CAPABILITY_MANIFEST_FILE,
  CAPABILITIES_DIR,
  DARWIN_DIR,
  HARNESS_DIR,
  HARNESS_FILE,
  META_SPEC_FILE,
  PROPOSALS_DIR,
  RUNS_DIR,
} from "./constants.js";
import { formatCliField, writeCliError } from "./display.js";

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
  /**
   * If true, each iteration uses Codex's /goal command as the execution
   * primitive instead of building a harness module. The proposer outputs
   * {goal, knobs, rationale} JSON; the runner injects /goal and watches
   * .darwin/events.jsonl for completion.
   */
  goalMode: boolean;
  /** Per-attempt hard time cap in ms (goal-mode only). */
  attemptMaxMs: number;
  /** Quiet period in ms before goal is considered done (goal-mode only). */
  attemptQuietMs: number;
  /**
   * Goal-mode execution primitive. Undefined means use runGoalAttempt's
   * normal default/env resolution.
   */
  goalRunner?: GoalRunner;
  /**
   * Harness-mode proposer launch mode. Undefined means use
   * DARWIN_PROPOSER_RUNNER or the default interactive runner.
   */
  proposerRunner?: ProposerRunner;
}

const MAX_CONSECUTIVE_FAILURES = 3;

export function parseLoopOptions(args: string[]): LoopOptions {
  let maxIterations = Infinity;
  const iterIdx = args.indexOf("--iterations");
  if (iterIdx !== -1) {
    const n = parseInt(args[iterIdx + 1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) maxIterations = n;
  }

  let maxDurationMs = Infinity;
  const durIdx = args.indexOf("--duration");
  if (durIdx !== -1) {
    const raw = args[durIdx + 1] ?? "";
    const parsed = parseDuration(raw);
    if (parsed !== null) maxDurationMs = parsed;
    else throw new Error(`invalid --duration value: ${formatErrorSummary(raw)} (use forms like 90s, 30m, 2h, 1d)`);
  }

  const interactive = args.includes("--interactive");
  const goalModeRequested = args.includes("--goal-mode");
  const harnessModeRequested =
    args.includes("--harness-mode") || args.includes("--no-goal-mode");
  if (goalModeRequested && harnessModeRequested) {
    throw new Error("choose either --goal-mode or --harness-mode, not both");
  }
  const goalMode = !harnessModeRequested;

  let attemptMaxMs = 30 * 60 * 1000;
  const attIdx = args.indexOf("--attempt-max");
  if (attIdx !== -1) {
    const raw = args[attIdx + 1] ?? "";
    const parsed = parseDuration(raw);
    if (parsed !== null) attemptMaxMs = parsed;
    else throw new Error(`invalid --attempt-max value: ${formatErrorSummary(raw)} (use forms like 90s, 30m, 2h)`);
  }

  let attemptQuietMs = 60_000;
  const quietIdx = args.indexOf("--attempt-quiet");
  if (quietIdx !== -1) {
    const raw = args[quietIdx + 1] ?? "";
    const parsed = parseDuration(raw);
    if (parsed !== null) attemptQuietMs = parsed;
    else throw new Error(`invalid --attempt-quiet value: ${formatErrorSummary(raw)} (use forms like 30s, 2m)`);
  }

  let goalRunner: GoalRunner | undefined;
  const runnerIdx = args.indexOf("--goal-runner");
  if (runnerIdx !== -1) {
    const raw = args[runnerIdx + 1] ?? "";
    if (raw === "initial" || raw === "exec" || raw === "slash") {
      goalRunner = raw;
    } else if (raw === "prompt") {
      goalRunner = "initial";
    } else {
      throw new Error(`invalid --goal-runner value: ${formatErrorSummary(raw)} (expected initial, exec, or slash)`);
    }
  }

  let proposerRunner: ProposerRunner | undefined;
  const proposerRunnerIdx = args.indexOf("--proposer-runner");
  if (proposerRunnerIdx !== -1) {
    const raw = args[proposerRunnerIdx + 1] ?? "";
    if (raw === "exec" || raw === "interactive") proposerRunner = raw;
    else throw new Error(`invalid --proposer-runner value: ${formatErrorSummary(raw)} (expected exec or interactive)`);
  }
  if (
    args.includes("--interactive-proposer") ||
    args.includes("--interactive-propose")
  ) {
    proposerRunner = "interactive";
  }

  return {
    maxIterations,
    maxDurationMs,
    interactive,
    goalMode,
    attemptMaxMs,
    attemptQuietMs,
    goalRunner,
    proposerRunner,
  };
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
  return formatDurationMs(ms);
}

interface ProposerPromptArgs {
  mode?: "harness" | "goal";
  engine: EngineName;
  task: string;
  currentHarness: string;
  frontierAttempt: string;
  frontierScore: number | null;
  priorHint?: string;
  specCapabilities?: string;
  capabilitiesContext: string;
  proposalDirRel: string;
  proposalPathRel: string;
  proposalManifestRel: string;
  parents?: ParentAttempt[];
  mutationDirective?: string;
}

const GOAL_PREVIEW_CHARS = 1_000;
const RATIONALE_PREVIEW_CHARS = 600;
const KNOBS_PREVIEW_CHARS = 400;
const PARENT_FIELD_PREVIEW_CHARS = 200;
const CAPABILITY_PROMOTION_FIELD_CHARS = 200;
const CAPABILITY_PROMOTION_NOTE_CHARS = 1_000;
const CAPABILITY_PROMOTION_ITEM_LIMIT = 8;
const CURRENT_HARNESS_PROMPT_CHARS = 20_000;
const NEXT_HINT_CHARS = 1_000;
const TASK_PROMPT_CHARS = 20_000;
const SPEC_CAPABILITIES_PROMPT_CHARS = 8_000;
const META_LOOP_SLUG_CHARS = 160;
const DEFAULT_SPEC_CAPABILITY_POLICY = [
  "- skills: allowed (repo-scoped Codex Agent Skills under .agents/skills after promotion)",
  "- hooks: allowed (native .codex/hooks.json entries that call darwin-hook only)",
  "- agents: disallowed",
  "- promotion: auto-promote validated skills/hooks for next iteration",
].join("\n");

function formatMetaPromptField(value: unknown): string {
  return formatErrorSummary(value, PARENT_FIELD_PREVIEW_CHARS);
}

export function formatGoalCandidateForTerminal(
  candidate: GoalCandidate,
  candidatePathRel: string,
): string {
  const savedPath = `${DARWIN_DIR}/${candidatePathRel}`;
  const suffix = `...[truncated; full candidate saved to ${savedPath}]`;
  const lines = [
    "",
    "darwin: proposed goal:",
    `  ${formatMultilinePreview(candidate.goal, {
      limit: GOAL_PREVIEW_CHARS,
      indent: "  ",
      truncatedSuffix: suffix,
    })}`,
  ];

  if (candidate.rationale?.trim()) {
    lines.push("  rationale:");
    lines.push(
      `    ${formatMultilinePreview(candidate.rationale, {
        limit: RATIONALE_PREVIEW_CHARS,
        indent: "    ",
        truncatedSuffix: suffix,
      })}`,
    );
  }

  const knobLine = Object.entries(candidate.knobs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (knobLine) lines.push(`  knobs: ${formatErrorSummary(knobLine, KNOBS_PREVIEW_CHARS)}`);

  return `${lines.join("\n")}\n`;
}

export function formatParentsForPrompt(parents: ParentAttempt[]): string {
  if (parents.length === 0) return "(none)";
  return parents
    .map((p) => {
      const attempt = formatMetaPromptField(p.attempt_id);
      const outcome = formatMetaPromptField(p.outcome);
      const lines = [`- ${attempt} (score=${p.score ?? "null"}, ${outcome})`];
      if (p.goal) {
        lines.push(`    goal: ${formatErrorSummary(p.goal, PARENT_FIELD_PREVIEW_CHARS)}`);
      }
      if (p.rationale) {
        lines.push(`    why: ${formatErrorSummary(p.rationale, PARENT_FIELD_PREVIEW_CHARS)}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export function formatFrontierForPrompt(
  attemptId: string,
  score: number | null,
): string {
  return [
    `- attempt_id: ${formatMetaPromptField(attemptId)}`,
    `- score: ${score ?? "null"}`,
  ].join("\n");
}

export function formatHarnessForPrompt(
  harnessSource: string,
  harnessPathRel = `${DARWIN_DIR}/${HARNESS_DIR}/${HARNESS_FILE}`,
): string {
  return formatMultilinePreview(harnessSource, {
    limit: CURRENT_HARNESS_PROMPT_CHARS,
    indent: "",
    truncatedSuffix: `// ...[truncated; full harness saved to ${harnessPathRel}]`,
  });
}

export function formatTaskForProposerPrompt(
  task: string,
  specPathRel = `${DARWIN_DIR}/${META_SPEC_FILE}`,
): string {
  return formatMultilinePreview(task, {
    limit: TASK_PROMPT_CHARS,
    indent: "",
    truncatedSuffix: `...[truncated; full task saved to ${specPathRel}]`,
  });
}

export function formatSpecCapabilitiesForPrompt(
  specCapabilities?: string,
  specPathRel = `${DARWIN_DIR}/${META_SPEC_FILE}`,
): string {
  const policy = specCapabilities?.trim() || DEFAULT_SPEC_CAPABILITY_POLICY;
  return formatMultilinePreview(policy, {
    limit: SPEC_CAPABILITIES_PROMPT_CHARS,
    indent: "",
    truncatedSuffix: `...[truncated; full capability policy saved to ${specPathRel}]`,
  });
}

export function formatCapabilityPromotionNote(
  promoted: string[],
): string | undefined {
  if (promoted.length === 0) return undefined;
  const shown = promoted
    .slice(0, CAPABILITY_PROMOTION_ITEM_LIMIT)
    .map((value) => formatErrorSummary(value, CAPABILITY_PROMOTION_FIELD_CHARS));
  const omitted = promoted.length - shown.length;
  if (omitted > 0) shown.push(`... ${omitted} more`);
  const summary = formatErrorSummary(
    shown.join(", "),
    CAPABILITY_PROMOTION_NOTE_CHARS,
  );
  return `capabilities promoted for next iteration: ${summary}`;
}

export function formatShortAdvisoryText(value: string): string {
  return formatErrorSummary(value.trim(), NEXT_HINT_CHARS);
}

export function normalizeNextHypothesisHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? formatShortAdvisoryText(trimmed) : undefined;
}

export function formatMetaLoopHeader(
  slug: string,
  opts: Pick<LoopOptions, "goalMode">,
  proposerRunner: ProposerRunner,
  bound: string,
): string {
  const label = formatErrorSummary(slug || "(unnamed)", META_LOOP_SLUG_CHARS);
  return `darwin: meta loop for "${label}" - ${bound} - ${opts.goalMode ? "goal-mode" : "harness-mode"} - proposer=${proposerRunner}`;
}

function buildProposerPrompt(a: ProposerPromptArgs): string {
  const priorHint = a.priorHint ? normalizeNextHypothesisHint(a.priorHint) : undefined;
  const mutationDirective = a.mutationDirective
    ? normalizeNextHypothesisHint(a.mutationDirective)
    : undefined;
  const hintBlock = priorHint
    ? `\nHINT FROM PRIOR HARNESS:\n${priorHint}\n\nYou may follow this hint or ignore it. It is the prior harness's\nsuggestion for where to focus next. If you ignore it, your hypothesis\nshould briefly say why.\n`
    : "\nHINT FROM PRIOR HARNESS:\n(none)\n";

  const parentsBlock = a.parents && a.parents.length > 0
    ? `\nPARENTS SELECTED BY STRATEGY (consider these specifically when mutating):\n${formatParentsForPrompt(a.parents)}\n`
    : "";

  const directiveBlock = mutationDirective
    ? `\nMUTATION DIRECTIVE FROM STRATEGY:\n${mutationDirective}\n`
    : "";
  const mode = a.mode ?? "harness";
  const harnessRole = mode === "goal"
    ? `The harness is an ESM JavaScript module (.mjs) that remains the
central evolutionary artifact in goal-mode. Its buildPrompt(task) method
returns the harness-shaped task context Darwin will feed to the /goal
proposer and include in the final /goal attempt. The current harness is
shown below.`
    : `The harness is an ESM JavaScript module (.mjs) that controls how the task
is presented to ${engineLabel(a.engine)} when the executor runs. The current
harness is shown below.`;

  return `You are darwin's meta-proposer. Your job: write ONE new harness file
that you believe will improve the score on this task.

${harnessRole}

TASK:
${formatTaskForProposerPrompt(a.task)}

CURRENT FRONTIER:
${formatFrontierForPrompt(a.frontierAttempt, a.frontierScore)}

CURRENT HARNESS (.darwin/harness/harness.mjs):
\`\`\`javascript
${formatHarnessForPrompt(a.currentHarness)}
\`\`\`
${hintBlock}${parentsBlock}${directiveBlock}
SPEC CAPABILITY POLICY:
${formatSpecCapabilitiesForPrompt(a.specCapabilities)}

PROJECT CAPABILITIES AVAILABLE THIS ITERATION:
${a.capabilitiesContext}

Capability availability rule:
- Only capabilities already listed above may be assumed by this iteration.
- Any new skill/hook you propose now is staged and may become available next iteration only.

YOUR ACTIONS:
- Read .darwin/evolution.jsonl and any .darwin/runs/*/ trajectories to
  understand what's been tried and what failed.
- Read .darwin/proposals/iter-*/harness.mjs to see prior candidates.
- Then write exactly ONE file at: ${a.proposalPathRel}
  The file must default-export an object with a buildPrompt(task) method
  that returns a non-empty string. It is plain ESM JavaScript — no
  TypeScript syntax, no transpile step. Use JSDoc for any type hints.
- Optionally, also export a suggestNextHypothesis() method returning a
  short string that the NEXT iteration's proposer will see as advisory.
- Do not import anything outside Node built-ins.
- Do not call shell, network, or filesystem-write APIs inside your harness.
- Do not modify any other file (no edits to .darwin/harness/, no edits to
  prior runs/proposals).

OPTIONAL PROJECT-SCOPED CAPABILITIES:
- You may stage reusable Codex skills or hooks for future iterations, but do
  not create agents. In Darwin, a skill is a Codex Agent Skill staged at
  .darwin/${a.proposalDirRel}/${CAPABILITIES_DIR}/skills/<skill-name>/SKILL.md
  with YAML name+description (the description is the trigger contract); optional
  references/, scripts/, and assets/ live beside SKILL.md and Darwin promotes it
  next iteration to .agents/skills/<skill-name>/SKILL.md.
- In Darwin, a hook is declared in ${a.proposalManifestRel}; Darwin converts it
  into native .codex/hooks.json and forces the safe command
  "darwin-hook <snake_case_event>". Use Codex events SessionStart, PreToolUse,
  PermissionRequest, PostToolUse, UserPromptSubmit, or Stop; add matcher only
  for tool/start events (for example Bash, apply_patch, or startup|resume).
  Hook logic belongs in .darwin/plugins/*.mjs and can return Codex-compatible
  JSON to add context, block/deny, or continue at Stop. Example manifest:
  {
    "version": 1,
    "capabilities": [
      {"kind":"skill","name":"example","path":"${CAPABILITIES_DIR}/skills/example/SKILL.md"},
      {"kind":"hook","name":"bash-guard","event":"PreToolUse","matcher":"Bash","mode":"block_or_allow"}
    ]
  }

Write a one-sentence hypothesis at the top of the file as a // comment.

Exit when the file is written.`;
}

export async function meta(
  args: string[],
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  const opts = parseLoopOptions(args);
  const proposerRunner = resolveProposerRunner(opts.proposerRunner);
  const cwd = process.cwd();

  // Pre-flight 1: spec must exist. If missing, ask the user before running init.
  const specPath = join(cwd, DARWIN_DIR, META_SPEC_FILE);
  if (!existsSync(specPath)) {
    const proceed = await promptYesNo(
      "darwin: no meta-spec.md found. Run `darwin init` first? [Y/n] ",
      true,
    );
    if (!proceed) {
      writeCliError("darwin: aborting. Run `darwin init` when ready.\n");
      return;
    }
    const { init } = await import("./init.js");
    await init(engine, engineArgs);
    if (!existsSync(specPath)) {
      throw new Error("init did not produce meta-spec.md; aborting");
    }
  }

  const spec = readSpec(cwd);
  if (!spec.task) {
    throw new Error(
      "meta-spec.md is missing a `## Task` section - re-run `darwin init` or edit the spec.",
    );
  }

  // Pre-flight 2: frontier must exist. If missing, auto-run baseline (no prompt — it's plumbing).
  let front = readFrontier(cwd);
  if (!front) {
    writeCliError("darwin: no frontier found, running baseline first\n");
    const { baseline } = await import("./baseline.js");
    await baseline(engine, engineArgs);
    front = readFrontier(cwd);
    if (!front) {
      throw new Error("baseline did not produce a frontier; aborting");
    }
  }

  ensureBaselineHarness(cwd);
  if (opts.goalMode) {
    const { ensureHooks } = await import("./setup.js");
    if (ensureHooks()) {
      writeCliError("darwin: installed .codex/hooks.json for goal-mode event tracking\n");
    }
  }

  writeCliError(`${formatMetaLoopHeader(spec.slug, opts, proposerRunner, formatBound(opts))}\n`);
  writeCliError(
    `darwin: current frontier: ${formatCliField(front.attempt_id)} (score=${front.score ?? "null"})\n`,
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
      writeCliError(`\ndarwin: reached --iterations cap (${opts.maxIterations})\n`);
      break;
    }
    // Stop: max duration
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= opts.maxDurationMs) {
      writeCliError(`\ndarwin: reached --duration cap (${formatDuration(opts.maxDurationMs)} elapsed)\n`);
      break;
    }

    const label = Number.isFinite(opts.maxIterations) ? `${i}/${opts.maxIterations}` : `${i}`;
    writeCliError(`\n=== iteration ${label} ===\n`);

    const outcome = opts.goalMode
      ? await runGoalIteration(i, cwd, spec, opts, engine, engineArgs, proposerRunner)
      : await runIteration(i, cwd, spec, engine, engineArgs, proposerRunner);

    // Stop: too many consecutive validation failures
    if (outcome === "rejected" || outcome === "failed") {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        writeCliError(
          `\ndarwin: ${MAX_CONSECUTIVE_FAILURES} consecutive failures - proposer appears stuck. Stopping.\n`,
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
        writeCliError(`darwin: stopped by user after ${i} iteration(s)\n`);
        break;
      }
    }
  }

  const finalFront = readFrontier(cwd);
  if (finalFront) {
    writeCliError(
      `\ndarwin: loop complete. final frontier: ${formatCliField(finalFront.attempt_id)} (score=${finalFront.score ?? "null"})\n`,
    );
  }
}

type IterationOutcome = "scored" | "skipped" | "failed" | "rejected";

async function loadStrategyRuntime() {
  const [context, contract, defaults] = await Promise.all([
    import("../strategy/context.js"),
    import("../strategy/contract.js"),
    import("../strategy/defaults.js"),
  ]);

  return {
    buildContext: context.buildContext,
    safeHook: contract.safeHook,
    isParentArray: contract.isParentArray,
    isString: contract.isString,
    isBoolean: contract.isBoolean,
    isPopulation: contract.isPopulation,
    defaultSelectParents: defaults.defaultSelectParents,
    defaultMutationDirective: defaults.defaultMutationDirective,
    defaultAcceptCandidate: defaults.defaultAcceptCandidate,
    defaultUpdatePopulation: defaults.defaultUpdatePopulation,
  };
}

type StrategyRuntime = Awaited<ReturnType<typeof loadStrategyRuntime>>;

/**
 * Run updatePopulation hook (or default), persist results, log promotion.
 * Returns whether the frontier moved.
 */
async function applyPopulationUpdate(
  cwd: string,
  hooks: Harness | undefined,
  ctx: StrategyContext,
  attempt: { attempt_id: string; score: number | null; run_dir: string; knobs?: Record<string, string> },
  strategy: StrategyRuntime,
  postFrontierHook?: () => void,
): Promise<{ frontierMoved: boolean; nextFrontierScore: number | null }> {
  const cur = ctx.frontier;
  const { readNiches, writeNiches } = await import("../state/niches.js");
  const curNiches = readNiches(cwd);
  const before: Population = curNiches ? { frontier: cur, niches: curNiches } : { frontier: cur };

  const after = strategy.safeHook<Population>(
    "updatePopulation",
    hooks?.updatePopulation,
    [attempt, before, ctx],
    () => strategy.defaultUpdatePopulation(attempt, before, ctx),
    strategy.isPopulation,
  );

  const frontierMoved = after.frontier.attempt_id !== cur.attempt_id;
  if (frontierMoved) {
    if (postFrontierHook) postFrontierHook();
    writeFrontier(after.frontier, cwd);
    writeCliError(
      `darwin: new frontier ${formatCliField(after.frontier.attempt_id)} (score ${after.frontier.score})\n`,
    );
  } else if (attempt.score !== null) {
    writeCliError(
      `darwin: ${formatCliField(attempt.attempt_id)} did not improve frontier (${attempt.score} vs ${cur.score})\n`,
    );
  }

  if (after.niches) writeNiches(after.niches, cwd);

  return { frontierMoved, nextFrontierScore: after.frontier.score };
}

/**
 * Load the current frontier harness (if it parses). Returns undefined if
 * the harness file is missing or doesn't load — defaults will be used.
 */
async function loadFrontierHarness(cwd: string): Promise<Harness | undefined> {
  try {
    return await loadHarness(harnessPath(cwd));
  } catch {
    return undefined;
  }
}

async function loadHarness(path: string): Promise<Harness> {
  const { loadAndValidate } = await import("../harness/load.js");
  return loadAndValidate(path);
}

async function runIteration(
  i: number,
  cwd: string,
  spec: SpecSlice,
  engine: EngineName,
  engineArgs: string[],
  proposerRunner: ProposerRunner,
): Promise<IterationOutcome> {
  const task = spec.task;
  const attemptId = `iter-${i}`;
  const proposalDir = join(cwd, DARWIN_DIR, PROPOSALS_DIR, attemptId);
  const proposalDirRel = `${PROPOSALS_DIR}/${attemptId}`;
  const proposalHarness = join(proposalDir, HARNESS_FILE);
  const proposalHarnessRel = `${DARWIN_DIR}/${proposalDirRel}/${HARNESS_FILE}`;
  const proposalManifestRel = `${DARWIN_DIR}/${proposalDirRel}/${CAPABILITY_MANIFEST_FILE}`;
  mkdirSync(proposalDir, { recursive: true });

  const front = readFrontier(cwd)!;
  const currentHarness = readFileSync(harnessPath(cwd), "utf-8");
  const priorHint = readLastEvolutionHint(cwd);
  const project = resolveCurrentProject(cwd);
  const capabilityTools = await import("../capabilities/manifest.js");
  const capabilitiesContext = capabilityTools.formatCapabilitiesForPrompt(
    capabilityTools.discoverCapabilities(cwd, project, {
      inspectLimit: capabilityTools.DEFAULT_CAPABILITY_OUTPUT_LIMIT,
    }),
  );

  // Strategy: load current harness's hooks, build ctx, ask for parents + directive.
  const frontierHooks = await loadFrontierHarness(cwd);
  const strategy = await loadStrategyRuntime();
  const ctx = strategy.buildContext({
    iteration: i,
    mode: "harness",
    frontier: front,
    history: readRecentEvolution(cwd, 50),
    spec,
  });
  const parents = strategy.safeHook<ParentAttempt[]>(
    "selectParents", frontierHooks?.selectParents, [ctx],
    () => strategy.defaultSelectParents(ctx), strategy.isParentArray,
  );
  const mutationDirective = strategy.safeHook<string>(
    "mutationDirective", frontierHooks?.mutationDirective, [ctx],
    () => strategy.defaultMutationDirective(ctx), strategy.isString,
  );

  const proposerPrompt = buildProposerPrompt({
    engine,
    task,
    currentHarness,
    frontierAttempt: front.attempt_id,
    frontierScore: front.score,
    priorHint,
    specCapabilities: spec.capabilities,
    capabilitiesContext,
    proposalDirRel,
    proposalPathRel: proposalHarnessRel,
    proposalManifestRel,
    parents,
    mutationDirective,
  });

  // 1. Propose
  writeCliError("darwin: invoking proposer...\n");
  try {
    const { invokeProposer } = await import("../proposer/invoke.js");
    await invokeProposer(proposerPrompt, proposalHarness, engine, engineArgs, {
      runner: proposerRunner,
    });
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: proposer failed: ${message}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `proposer error: ${message}`,
      },
      cwd,
    );
    return "failed";
  }

  // 2. Validate
  let capabilityBundle: ValidatedCapabilityBundle | null = null;
  try {
    capabilityBundle = capabilityTools.validateCapabilityProposal(cwd, proposalDir, project);
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: candidate ${attemptId} rejected (capabilities: ${message})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `capability validation: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }

  let harness: Harness;
  try {
    harness = await loadHarness(proposalHarness);
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: candidate ${attemptId} rejected (${message})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `validation: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }
  writeCliError("darwin: candidate validated\n");

  // 2b. Strategy: ask the candidate harness whether to accept its own execution.
  const accepted = strategy.safeHook<boolean>(
    "acceptCandidate", harness.acceptCandidate, [harness, ctx],
    () => strategy.defaultAcceptCandidate(harness, ctx), strategy.isBoolean,
  );
  if (!accepted) {
    writeCliError(`darwin: candidate ${attemptId} rejected by strategy acceptCandidate hook\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: "rejected by strategy.acceptCandidate",
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }

  // 3. Execute
  const runDir = join(cwd, DARWIN_DIR, RUNS_DIR, attemptId);
  const runDirRel = `${RUNS_DIR}/${attemptId}`;
  mkdirSync(runDir, { recursive: true });
  copyFileSync(proposalHarness, join(runDir, HARNESS_FILE));

  const prompt = harness.buildPrompt(task);
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  writeFileSync(join(runDir, "task.md"), task + "\n");

  writeCliError(
    `darwin: launching ${formatEngineCommandForLog(engine, engineArgs)} (${engineLabel(engine)}, interactive) with candidate harness\n`,
  );
  const startedAt = Date.now();
  const { spawnEngine } = await import("../runtime/bridge.js");
  const { exitInfo } = spawnEngine(engine, [prompt], { engineArgs });
  const { engine: completedEngine, code: exitCode } = await exitInfo;
  const endedAt = Date.now();
  writeCliError(
    `darwin: ${engineCommand(completedEngine)} exited (code ${exitCode}, ${formatDurationMs(endedAt - startedAt)})\n`,
  );

  // 4. Score (dispatched per meta-spec.md's `## Scorer` section)
  const { scoreRun } = await import("../scorer/index.js");
  const { score, note } = await scoreRun(spec.scorer, runDir);

  // 5. Hint from this harness for the next iteration
  let nextHint: string | undefined;
  if (typeof harness.suggestNextHypothesis === "function") {
    try {
      nextHint = normalizeNextHypothesisHint(harness.suggestNextHypothesis());
    } catch {
      /* advisory only — ignore */
    }
  }

  // 6. Promote validated capabilities for the NEXT iteration.
  let capabilityNote: string | undefined;
  try {
    const promotion = capabilityTools.promoteCapabilities(cwd, capabilityBundle, project);
    capabilityNote = formatCapabilityPromotionNote(promotion.promoted);
    if (capabilityNote) {
      writeCliError(`darwin: ${capabilityNote}\n`);
    }
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: capability promotion failed: ${message}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `capability promotion: ${message}`,
        run_dir: runDirRel,
      },
      cwd,
    );
    return "failed";
  }

  // 7. Record
  const t = new Date().toISOString();
  const outcome = score === null ? "skipped" : "scored";
  const front2 = readFrontier(cwd)!;
  const delta = score !== null && front2.score !== null ? score - front2.score : undefined;
  const finalNote = [note, capabilityNote].filter(Boolean).join("\n");

  appendEvolution(
    {
      t,
      attempt_id: attemptId,
      score,
      outcome,
      note: finalNote,
      run_dir: runDirRel,
      delta,
      next_hint: nextHint,
    },
    cwd,
  );

  // 7. Strategy: update population (defaults to greedy frontier replace).
  //    On frontier promotion, also copy candidate harness to active harness.
  const updateCtx = strategy.buildContext({
    iteration: i,
    mode: "harness",
    frontier: front2,
    history: readRecentEvolution(cwd, 50),
    spec,
  });
  await applyPopulationUpdate(
    cwd,
    harness,
    updateCtx,
    { attempt_id: attemptId, score, run_dir: runDirRel },
    strategy,
    () => copyFileSync(proposalHarness, harnessPath(cwd)),
  );

  return outcome as IterationOutcome;
}

async function runGoalIteration(
  i: number,
  cwd: string,
  spec: SpecSlice,
  opts: LoopOptions,
  engine: EngineName,
  engineArgs: string[],
  proposerRunner: ProposerRunner,
): Promise<IterationOutcome> {
  const task = spec.task;
  const attemptId = `iter-${i}`;
  const proposalDir = join(cwd, DARWIN_DIR, PROPOSALS_DIR, attemptId);
  const proposalDirRel = `${PROPOSALS_DIR}/${attemptId}`;
  const proposalHarness = join(proposalDir, HARNESS_FILE);
  const proposalHarnessRel = `${DARWIN_DIR}/${proposalDirRel}/${HARNESS_FILE}`;
  const proposalManifestRel = `${DARWIN_DIR}/${proposalDirRel}/${CAPABILITY_MANIFEST_FILE}`;
  const runDir = join(cwd, DARWIN_DIR, RUNS_DIR, attemptId);
  const runDirRel = `${RUNS_DIR}/${attemptId}`;
  mkdirSync(proposalDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const front = readFrontier(cwd)!;
  const priorHint = readLastEvolutionHint(cwd);
  const currentHarness = readFileSync(harnessPath(cwd), "utf-8");
  const project = resolveCurrentProject(cwd);
  const capabilityTools = await import("../capabilities/manifest.js");
  const capabilitiesContext = capabilityTools.formatCapabilitiesForPrompt(
    capabilityTools.discoverCapabilities(cwd, project, {
      inspectLimit: capabilityTools.DEFAULT_CAPABILITY_OUTPUT_LIMIT,
    }),
  );

  // Strategy: harness hooks shape what the goal proposer sees.
  // In goal-mode there isn't always a harness file, so hooks are optional;
  // when absent, defaults give "recent 5" — same as before this change.
  const frontierHooks = await loadFrontierHarness(cwd);
  const strategy = await loadStrategyRuntime();
  const ctx = strategy.buildContext({
    iteration: i,
    mode: "goal",
    frontier: front,
    history: readRecentEvolution(cwd, 50),
    spec,
  });
  const parents = strategy.safeHook<ParentAttempt[]>(
    "selectParents", frontierHooks?.selectParents, [ctx],
    () => strategy.defaultSelectParents(ctx), strategy.isParentArray,
  );
  const mutationDirective = strategy.safeHook<string>(
    "mutationDirective", frontierHooks?.mutationDirective, [ctx],
    () => strategy.defaultMutationDirective(ctx), strategy.isString,
  );

  const harnessProposerPrompt = buildProposerPrompt({
    mode: "goal",
    engine,
    task,
    currentHarness,
    frontierAttempt: front.attempt_id,
    frontierScore: front.score,
    priorHint,
    specCapabilities: spec.capabilities,
    capabilitiesContext,
    proposalDirRel,
    proposalPathRel: proposalHarnessRel,
    proposalManifestRel,
    parents,
    mutationDirective,
  });

  // 1. Propose and validate the next harness first. In goal-mode this harness
  // shapes the goal proposal and is promoted when the attempt becomes the
  // frontier, keeping harness.mjs central even though /goal is the executor.
  writeCliError("darwin: invoking goal harness proposer...\n");
  try {
    const { invokeProposer } = await import("../proposer/invoke.js");
    await invokeProposer(harnessProposerPrompt, proposalHarness, engine, engineArgs, {
      runner: proposerRunner,
    });
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: goal harness proposer failed: ${message}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `harness proposer error: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "failed";
  }

  let capabilityBundle: ValidatedCapabilityBundle | null = null;
  try {
    capabilityBundle = capabilityTools.validateCapabilityProposal(cwd, proposalDir, project);
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: candidate ${attemptId} rejected (capabilities: ${message})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `capability validation: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }

  let harness: Harness;
  try {
    harness = await loadHarness(proposalHarness);
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: candidate ${attemptId} rejected (${message})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `harness validation: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }

  let harnessPrompt: string;
  try {
    harnessPrompt = harness.buildPrompt(task);
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: candidate ${attemptId} rejected (buildPrompt: ${message})\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: `buildPrompt: ${message}`,
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }
  if (!harnessPrompt.trim()) {
    writeCliError(`darwin: candidate ${attemptId} rejected (buildPrompt returned empty task context)\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: "buildPrompt returned empty task context",
        run_dir: proposalDirRel,
      },
      cwd,
    );
    return "rejected";
  }
  writeCliError("darwin: goal harness candidate validated\n");

  const recent = parents.filter((p) => p.attempt_id !== "baseline");
  const goalProposer = await import("../proposer/goal-proposer.js");

  const proposerPrompt = goalProposer.buildGoalProposerPrompt({
    task: harnessPrompt,
    frontierAttempt: front.attempt_id,
    frontierScore: front.score,
    priorAttempts: recent,
    priorHint: mutationDirective
      ? `${priorHint ?? ""}${priorHint ? "\n\n" : ""}STRATEGY DIRECTIVE: ${mutationDirective}`
      : priorHint,
  });

  // 2. Propose a /goal candidate from the harness-shaped task context.
  let candidate: GoalCandidate;
  try {
    candidate = await goalProposer.invokeGoalProposer(proposerPrompt, cwd, {
      engine,
      engineArgs,
      runner: proposerRunner,
      outputPath: join(runDir, "candidate.json"),
    });
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: goal proposer failed: ${message}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `proposer error: ${message}`,
        run_dir: runDirRel,
      },
      cwd,
    );
    return "failed";
  }

  writeFileSync(join(runDir, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n");
  writeFileSync(join(runDir, "task.md"), task + "\n");
  writeFileSync(join(runDir, "harness-prompt.md"), harnessPrompt.trim() + "\n");
  copyFileSync(proposalHarness, join(runDir, HARNESS_FILE));

  writeCliError(formatGoalCandidateForTerminal(candidate, `${runDirRel}/candidate.json`));

  // 3a. Strategy: acceptCandidate hook (e.g. simulated annealing rejection).
  const strategyAccepted = strategy.safeHook<boolean>(
    "acceptCandidate", harness.acceptCandidate, [candidate, ctx],
    () => strategy.defaultAcceptCandidate(candidate, ctx), strategy.isBoolean,
  );
  if (!strategyAccepted) {
    writeCliError(`darwin: candidate ${attemptId} rejected by strategy acceptCandidate hook\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: "rejected by strategy.acceptCandidate",
        run_dir: runDirRel,
        goal: candidate.goal,
        rationale: candidate.rationale,
      },
      cwd,
    );
    return "rejected";
  }

  // 3b. Optional HITL approval (BEFORE execution). Preserve the unbounded
  // operator confirmation path; only bounded non-interactive runs auto-approve
  // so demos and CI do not hang.
  const approved = shouldPromptForGoalApproval(opts)
    ? await promptYesNo(
        "\nrun this goal? [Y/n/skip] ",
        true,
      )
    : true;
  if (!approved) {
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "rejected",
        note: "user rejected proposed goal",
        run_dir: runDirRel,
        goal: candidate.goal,
        rationale: candidate.rationale,
      },
      cwd,
    );
    return "rejected";
  }

  // 4. Execute the goal. Default to an initial `/goal ...` prompt so the real
  // Codex goal machinery is active while Darwin still terminates on quiet and
  // advances multi-iteration runs automatically. Users can explicitly ask for
  // non-slash exec automation or the legacy post-start TUI injection path.
  writeCliError(`darwin: launching ${engineLabel(engine)} goal attempt\n`);
  const { runGoalAttempt } = await import("../runtime/goal-attempt.js");
  const result = await runGoalAttempt({
    goal: buildGoalModeAttemptGoal(candidate.goal, harnessPrompt),
    cwd,
    engine,
    engineArgs,
    knobs: candidate.knobs,
    runner: resolveLoopGoalRunner(opts),
    maxDurationMs: opts.attemptMaxMs,
    quietMs: opts.attemptQuietMs,
    trajectoryPath: join(runDir, "trajectory.json"),
  });
  writeCliError(
    `darwin: goal attempt finished (${result.exitReason}, ${formatDurationMs(result.durationMs)}, ${sumCounts(result.eventCounts)} events)\n`,
  );

  if (result.lastAssistantMessage) {
    writeFileSync(join(runDir, "last_message.md"), result.lastAssistantMessage);
  }

  // 5. Score
  const { scoreRun } = await import("../scorer/index.js");
  const { score, note } = await scoreRun(spec.scorer, runDir);

  // 6. Promote validated capabilities for the NEXT iteration.
  let capabilityNote: string | undefined;
  try {
    const promotion = capabilityTools.promoteCapabilities(cwd, capabilityBundle, project);
    capabilityNote = formatCapabilityPromotionNote(promotion.promoted);
    if (capabilityNote) {
      writeCliError(`darwin: ${capabilityNote}\n`);
    }
  } catch (e) {
    const message = formatErrorSummary(e);
    writeCliError(`darwin: capability promotion failed: ${message}\n`);
    appendEvolution(
      {
        t: new Date().toISOString(),
        attempt_id: attemptId,
        score: null,
        outcome: "failed",
        note: `capability promotion: ${message}`,
        run_dir: runDirRel,
      },
      cwd,
    );
    return "failed";
  }

  // 7. Record
  const t = new Date().toISOString();
  const outcome = score === null ? "skipped" : "scored";
  const front2 = readFrontier(cwd)!;
  const delta = score !== null && front2.score !== null ? score - front2.score : undefined;
  const finalNote = [note, capabilityNote].filter(Boolean).join("\n");

  const knobsRecord: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate.knobs)) {
    if (typeof v === "string") knobsRecord[k] = v;
  }

  appendEvolution(
    {
      t,
      attempt_id: attemptId,
      score,
      outcome,
      note: finalNote,
      run_dir: runDirRel,
      delta,
      goal: candidate.goal,
      rationale: candidate.rationale,
      knobs: knobsRecord,
      exit_reason: result.exitReason,
      duration_s: Math.round(result.durationMs / 1000),
    },
    cwd,
  );

  // 8. Strategy: updatePopulation hook (defaults to greedy frontier replace).
  const updateCtx = strategy.buildContext({
    iteration: i,
    mode: "goal",
    frontier: front2,
    history: readRecentEvolution(cwd, 50),
    spec,
  });
  await applyPopulationUpdate(
    cwd,
    harness,
    updateCtx,
    { attempt_id: attemptId, score, run_dir: runDirRel, knobs: knobsRecord },
    strategy,
    () => copyFileSync(proposalHarness, harnessPath(cwd)),
  );
  // Silence unused: delta is informational; the helper prints its own line.
  void delta;

  return outcome as IterationOutcome;
}

export function shouldPromptForGoalApproval(
  opts: Pick<LoopOptions, "interactive" | "maxIterations" | "maxDurationMs">,
): boolean {
  const unbounded = !Number.isFinite(opts.maxIterations) && !Number.isFinite(opts.maxDurationMs);
  return opts.interactive || unbounded;
}

export function resolveLoopGoalRunner(
  opts: Pick<LoopOptions, "goalRunner" | "interactive" | "maxIterations" | "maxDurationMs">,
  rawGoalAttemptMode = process.env.DARWIN_GOAL_ATTEMPT_MODE,
): GoalRunner | undefined {
  if (opts.goalRunner) return opts.goalRunner;
  if (rawGoalAttemptMode?.trim()) return undefined;
  return "initial";
}

export function buildGoalModeAttemptGoal(
  goal: string,
  harnessPrompt: string,
): string {
  const trimmedGoal = goal.trim();
  const trimmedHarnessPrompt = harnessPrompt.trim();
  if (!trimmedHarnessPrompt) return trimmedGoal;
  return `${trimmedGoal}

Harness-generated task context:
${trimmedHarnessPrompt}

Use the harness-generated context as the authoritative task framing for this goal-mode attempt.`;
}

function sumCounts(counts: Record<string, number>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

/**
 * Minimal yes/no prompt. `defaultYes` controls whether bare-enter means
 * "yes" or "no". Accepts y/yes/Y for yes, n/no/N for no, anything else
 * counts as the default.
 */
async function promptYesNo(message: string, defaultYes: boolean): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
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
