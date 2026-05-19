import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineEnv,
  engineExecArgs,
  engineInteractiveArgs,
  fallbackEngine,
  fallbackNotice,
  formatEngineCommandForLog,
  isEngineLaunchError,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { spawnEngine } from "../runtime/bridge.js";
import {
  formatDurationMs,
  formatErrorSummary,
  formatMultilinePreview,
  formatPathForTerminal,
  resolvePositiveInt,
} from "../runtime/diagnostics.js";
import { fileExists, waitForFile } from "../runtime/file-wait.js";
import { terminateChildProcess } from "../runtime/process-tree.js";
import {
  formatQuietChildStderrTail,
  runQuietChild,
} from "../runtime/quiet-child.js";
import { writeTerminalError } from "../runtime/terminal.js";
import { resolveProposerRunner, type ProposerRunner } from "./runner.js";

export interface GoalCandidate {
  goal: string;
  knobs: {
    model?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approval?: "untrusted" | "on-failure" | "never";
  };
  rationale: string;
}

export interface ProposerInputs {
  task: string;
  frontierAttempt: string;
  frontierScore: number | null;
  priorAttempts: Array<{
    attempt_id: string;
    score: number | null;
    outcome: string;
    goal?: string;
    rationale?: string;
  }>;
  priorHint?: string;
}

export interface GoalProposerOptions {
  engine?: EngineName;
  engineArgs?: string[];
  runner?: ProposerRunner;
  outputPath?: string;
}

const DEFAULT_PROPOSER_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_GOAL_PROPOSER_TIMEOUT_MS = 10 * 60 * 1000;
const INTERACTIVE_GOAL_PROPOSER_OUTPUT_POLL_MS = 250;
const INTERACTIVE_GOAL_PROPOSER_OUTPUT_SETTLE_MS = 500;
const INTERACTIVE_GOAL_PROPOSER_KILL_GRACE_MS = 5_000;
const GOAL_PROPOSER_HISTORY_FIELD_CHARS = 200;
const GOAL_PROPOSER_HINT_CHARS = 1_000;
const GOAL_PROPOSER_TASK_CHARS = 20_000;

export function buildGoalProposerPrompt(a: ProposerInputs): string {
  const history = formatGoalProposerAttemptsForPrompt(a.priorAttempts);
  const priorHint = formatGoalProposerHint(a.priorHint);
  const task = formatGoalProposerTaskForPrompt(a.task);

  const hint = priorHint
    ? `\nADVISORY HINT FROM PRIOR ATTEMPT:\n${priorHint}\n`
    : "";

  return `You are darwin's meta-proposer for /goal-mode iteration.
Your job: propose ONE goal statement and a small set of execution knobs
that you believe will improve the score on this task.

A "goal" is a single natural-language instruction that will be passed to
Codex via its /goal slash command. Codex will then run autonomously toward
the goal across multiple turns until it considers the goal satisfied.

TASK:
${task}

CURRENT FRONTIER:
- attempt_id: ${formatGoalProposerField(a.frontierAttempt)}
- score: ${a.frontierScore ?? "null"}

RECENT ATTEMPTS (most recent last):
${history}
${hint}
OUTPUT FORMAT (STRICT):
Your final assistant message must be a single JSON object on its own,
no surrounding prose, no markdown fence, with these fields:

{
  "goal": "<one-paragraph goal statement, plain text, no newlines>",
  "knobs": {
    "model":    "<optional codex model id, e.g. gpt-5-codex>",
    "sandbox":  "<optional: read-only | workspace-write | danger-full-access>",
    "approval": "<optional: untrusted | on-failure | never>"
  },
  "rationale": "<2-3 sentences: what hypothesis this goal tests vs prior attempts>"
}

GUIDANCE:
- The goal should be specific enough that Codex knows when it is satisfied.
- Avoid restating the entire task; assume Codex has read meta-spec.md.
- Vary one or two dimensions vs the frontier - don't change everything at once.
- Omit knob fields you don't want to override.

Exit when you have emitted the JSON.`;
}

export function formatGoalProposerAttemptsForPrompt(
  attempts: ProposerInputs["priorAttempts"],
): string {
  if (attempts.length === 0) return "(none yet)";
  return attempts
    .slice(-5)
    .map((p) => {
      const attempt = formatGoalProposerField(p.attempt_id);
      const outcome = formatGoalProposerField(p.outcome);
      const lines = [
        `- ${attempt} (score=${p.score ?? "null"}, ${outcome})`,
      ];
      if (p.goal) {
        lines.push(
          `    goal: ${formatErrorSummary(p.goal, GOAL_PROPOSER_HISTORY_FIELD_CHARS)}`,
        );
      }
      if (p.rationale) {
        lines.push(
          `    why: ${formatErrorSummary(p.rationale, GOAL_PROPOSER_HISTORY_FIELD_CHARS)}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

function formatGoalProposerField(value: unknown): string {
  return formatErrorSummary(value, GOAL_PROPOSER_HISTORY_FIELD_CHARS);
}

export function formatGoalProposerHint(hint: string | undefined): string | undefined {
  if (!hint?.trim()) return undefined;
  return formatErrorSummary(hint.trim(), GOAL_PROPOSER_HINT_CHARS);
}

export function formatGoalProposerTaskForPrompt(
  task: string,
  specPathRel = ".darwin/meta-spec.md",
): string {
  return formatMultilinePreview(task, {
    limit: GOAL_PROPOSER_TASK_CHARS,
    indent: "",
    truncatedSuffix: `...[truncated; full task saved to ${specPathRel}]`,
  });
}

/**
 * Spawn the selected engine's `exec` mode with the proposer prompt and capture
 * its final
 * assistant message. Returns the parsed GoalCandidate.
 *
 * Uses --output-last-message so we get clean JSON without parsing JSONL
 * event stream. --skip-git-repo-check so it runs in any cwd.
 *
 * Important: this nested proposer is plumbing, not the actual attempt. Disable
 * Codex hooks here so global hook stacks (for example OMX SessionStart hooks)
 * cannot block the meta loop before Darwin has even proposed a goal.
 */
export async function invokeGoalProposer(
  prompt: string,
  cwd: string,
  options: GoalProposerOptions = {},
): Promise<GoalCandidate> {
  const engine = options.engine ?? DEFAULT_ENGINE;
  const selectedEngineArgs = options.engineArgs ?? resolveEngineArgs(engine);
  const runner = resolveProposerRunner(options.runner);
  try {
    return await invokeGoalProposerWithEngine(
      prompt,
      cwd,
      engine,
      selectedEngineArgs,
      runner,
      options.outputPath,
    );
  } catch (err) {
    const fallback = fallbackEngine(engine);
    if (fallback && isEngineLaunchError(err)) {
      writeTerminalError(fallbackNotice(engine, fallback, err));
      return await invokeGoalProposerWithEngine(
        prompt,
        cwd,
        fallback,
        resolveEngineArgs(fallback),
        runner,
        options.outputPath,
      );
    }
    throw err;
  }
}

async function invokeGoalProposerWithEngine(
  prompt: string,
  cwd: string,
  engine: EngineName,
  selectedEngineArgs: string[],
  runner: ProposerRunner,
  outputPath?: string,
): Promise<GoalCandidate> {
  if (runner === "interactive") {
    return invokeInteractiveGoalProposerWithEngine(
      prompt,
      cwd,
      engine,
      selectedEngineArgs,
      outputPath,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "darwin-proposer-"));
  const lastMsgPath = join(tmp, "last.txt");
  const timeoutMs = resolveGoalProposerTimeoutMs(
    process.env.DARWIN_GOAL_PROPOSER_TIMEOUT_MS,
  );

  try {
    const args = engineExecArgs(engine, selectedEngineArgs, [
      "--skip-git-repo-check",
      "--disable",
      "hooks",
      "--output-last-message",
      lastMsgPath,
      "--color",
      "never",
      "-",
    ]);

    writeTerminalError(
      `darwin: invoking ${formatEngineCommandForLog(engine, args)} for goal proposer...`,
    );
    const result = await runQuietChild({
      command: engineCommand(engine),
      args,
      cwd,
      env: engineEnv(engine),
      input: prompt + "\n",
      timeoutMs,
      timeoutLabel: "goal proposer",
      writeStatus: writeTerminalError,
    });
    if (result.timedOut) {
      throw new Error(
        `${engineCommand(engine)} goal proposer timed out after ${formatDurationMs(timeoutMs)}`,
      );
    }
    if (result.code !== 0) {
      const tail = formatQuietChildStderrTail("goal proposer", result.stderrTail);
      if (tail) writeTerminalError(tail);
      throw new Error(`${engineCommand(engine)} exec exited ${result.code}`);
    }

    const raw = readFileSync(lastMsgPath, "utf-8");
    return parseGoalCandidate(raw);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function invokeInteractiveGoalProposerWithEngine(
  prompt: string,
  cwd: string,
  engine: EngineName,
  selectedEngineArgs: string[],
  outputPath: string | undefined,
): Promise<GoalCandidate> {
  const tmp = outputPath ? undefined : mkdtempSync(join(tmpdir(), "darwin-goal-proposer-"));
  const candidatePath = outputPath ?? join(tmp!, "candidate.json");
  const args = engineInteractiveArgs(engine, selectedEngineArgs);
  const interactivePrompt = `${prompt}

IMPORTANT FOR DARWIN:
Do not merely print the JSON. Write the final JSON object to this exact file path:
${candidatePath}

Create parent directories if needed. Darwin will detect the file and continue automatically.`;

  try {
    writeTerminalError(
      `darwin: launching ${formatEngineCommandForLog(engine, args)} <goal proposer prompt> for interactive goal proposer`,
    );
    writeTerminalError(
      `darwin: Darwin will continue automatically after the goal proposer writes ${formatGoalProposerCandidatePathForTerminal(candidatePath, cwd)}`,
    );

    const { child, exitInfo } = spawnEngine(engine, [interactivePrompt], {
      cwd,
      engineArgs: args,
    });
    const first = await Promise.race([
      exitInfo.then((info) => ({ kind: "exit" as const, info })),
      waitForFile(candidatePath, {
        pollMs: INTERACTIVE_GOAL_PROPOSER_OUTPUT_POLL_MS,
        settleMs: INTERACTIVE_GOAL_PROPOSER_OUTPUT_SETTLE_MS,
      }).then(() => ({ kind: "file" as const })),
    ]);

    if (first.kind === "file") {
      writeTerminalError(
        "darwin: goal proposer wrote candidate; closing interactive proposer and continuing",
      );
      await terminateChildProcess(child, {
        killGraceMs: INTERACTIVE_GOAL_PROPOSER_KILL_GRACE_MS,
      });
      return parseGoalCandidate(readFileSync(candidatePath, "utf-8"));
    }

    const { engine: completedEngine, code } = first.info;
    if (!fileExists(candidatePath)) {
      throw new Error(
        `goal proposer did not write ${formatGoalProposerCandidatePathForTerminal(candidatePath, cwd)}`,
      );
    }
    if (code !== 0) {
      throw new Error(`${engineCommand(completedEngine)} exited with code ${code}`);
    }
    return parseGoalCandidate(readFileSync(candidatePath, "utf-8"));
  } finally {
    if (tmp) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export function formatGoalProposerCandidatePathForTerminal(
  candidatePath: string,
  cwd = process.cwd(),
): string {
  return formatPathForTerminal(candidatePath, { cwd });
}

export function resolveGoalProposerTimeoutMs(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_PROPOSER_TIMEOUT_MS, MAX_GOAL_PROPOSER_TIMEOUT_MS);
}

/**
 * Extract a GoalCandidate from a proposer's final message. Tolerates an
 * optional markdown code fence around the JSON.
 */
export function parseGoalCandidate(raw: string): GoalCandidate {
  const text = stripFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`proposer output is not valid JSON: ${formatErrorSummary(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("proposer output must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const goal = obj.goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error('proposer output missing required "goal" string');
  }

  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";

  const knobsIn = (obj.knobs && typeof obj.knobs === "object" && !Array.isArray(obj.knobs))
    ? (obj.knobs as Record<string, unknown>)
    : {};
  const knobs: GoalCandidate["knobs"] = {};
  if (typeof knobsIn.model === "string" && knobsIn.model.trim()) {
    knobs.model = knobsIn.model.trim();
  }
  if (typeof knobsIn.sandbox === "string") {
    const s = knobsIn.sandbox.trim();
    if (s === "read-only" || s === "workspace-write" || s === "danger-full-access") {
      knobs.sandbox = s;
    }
  }
  if (typeof knobsIn.approval === "string") {
    const a = knobsIn.approval.trim();
    if (a === "untrusted" || a === "on-failure" || a === "never") {
      knobs.approval = a;
    }
  }

  return { goal: goal.trim(), knobs, rationale: rationale.trim() };
}

function stripFence(s: string): string {
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : s;
}
