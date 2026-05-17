import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderr } from "node:process";

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

export function buildGoalProposerPrompt(a: ProposerInputs): string {
  const history = a.priorAttempts.length
    ? a.priorAttempts
        .slice(-5)
        .map(
          (p) =>
            `- ${p.attempt_id} (score=${p.score ?? "null"}, ${p.outcome})${p.goal ? `\n    goal: ${truncate(p.goal, 200)}` : ""}${p.rationale ? `\n    why: ${truncate(p.rationale, 200)}` : ""}`,
        )
        .join("\n")
    : "(none yet)";

  const hint = a.priorHint
    ? `\nADVISORY HINT FROM PRIOR ATTEMPT:\n${a.priorHint}\n`
    : "";

  return `You are darwin's meta-proposer for /goal-mode iteration.
Your job: propose ONE goal statement and a small set of execution knobs
that you believe will improve the score on this task.

A "goal" is a single natural-language instruction that will be passed to
Codex via its /goal slash command. Codex will then run autonomously toward
the goal across multiple turns until it considers the goal satisfied.

TASK:
${a.task}

CURRENT FRONTIER:
- attempt_id: ${a.frontierAttempt}
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
- Vary one or two dimensions vs the frontier — don't change everything at once.
- Omit knob fields you don't want to override.

Exit when you have emitted the JSON.`;
}

/**
 * Spawn `codex exec` with the proposer prompt and capture its final
 * assistant message. Returns the parsed GoalCandidate.
 *
 * Uses --output-last-message so we get clean JSON without parsing JSONL
 * event stream. --skip-git-repo-check so it runs in any cwd.
 */
export async function invokeGoalProposer(
  prompt: string,
  cwd: string,
): Promise<GoalCandidate> {
  const tmp = mkdtempSync(join(tmpdir(), "darwin-proposer-"));
  const lastMsgPath = join(tmp, "last.txt");

  try {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--output-last-message",
      lastMsgPath,
      "--color",
      "never",
      prompt,
    ];

    stderr.write("darwin: invoking codex exec for goal proposer...\n");
    const code = await new Promise<number>((res, rej) => {
      const child = spawn("codex", args, {
        cwd,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", rej);
      child.on("exit", (c) => res(c ?? 1));
    });
    if (code !== 0) {
      throw new Error(`codex exec exited ${code}`);
    }

    const raw = readFileSync(lastMsgPath, "utf-8");
    return parseGoalCandidate(raw);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
    throw new Error(`proposer output is not valid JSON: ${e}`);
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
