import { spawn } from "node:child_process";
import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stderr } from "node:process";
import { DARWIN_DIR, EVENTS_LOG } from "../cli/constants.js";

export type GoalExitReason =
  | "quiet"          // no new tool/prompt activity within quietMs after last `stop`
  | "time_cap"       // hit hard wall-clock cap
  | "codex_exit"     // codex exited on its own
  | "error";         // spawn or io error

export interface GoalAttemptResult {
  exitReason: GoalExitReason;
  durationMs: number;
  /** Last assistant message text observed via `stop` event payload, if any. */
  lastAssistantMessage?: string;
  /** Per-event counts seen during the attempt. Useful for scorers + telemetry. */
  eventCounts: Record<string, number>;
  /** Codex process exit code, if the process exited (null if we killed it). */
  exitCode: number | null;
}

export interface GoalAttemptOptions {
  /** The natural-language goal to /goal into Codex. */
  goal: string;
  /** cwd for the codex child (and where .darwin/events.jsonl lives). */
  cwd: string;
  /** Per-attempt knobs forwarded to codex CLI flags. */
  knobs?: {
    model?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approval?: "untrusted" | "on-failure" | "never";
  };
  /** Hard wall-clock cap in ms. Default: 30 minutes. */
  maxDurationMs?: number;
  /**
   * Quiet period in ms after the last `stop` event with no further
   * `pre_tool_use` / `user_prompt_submit` activity, after which we consider
   * the goal "done." Default: 60s.
   */
  quietMs?: number;
  /** Grace period after /quit before SIGTERM. Default: 5s. */
  gracefulMs?: number;
  /** Delay after spawn before injecting /goal, to let TUI initialize. Default: 1500ms. */
  tuiWarmupMs?: number;
  /** Optional path to write a per-attempt trajectory summary. */
  trajectoryPath?: string;
}

const DEFAULTS = {
  maxDurationMs: 30 * 60 * 1000,
  quietMs: 60_000,
  gracefulMs: 5_000,
  tuiWarmupMs: 1_500,
};

/**
 * Run one Codex /goal attempt. Spawns codex interactively (TUI visible to
 * the user), injects `/goal <text>` once the TUI is ready, then watches
 * .darwin/events.jsonl to decide when the goal has stopped making progress.
 *
 * Completion heuristic: after we see a `stop` event, start a quiet timer.
 * Any subsequent `pre_tool_use` / `user_prompt_submit` resets it. When the
 * timer expires we treat the goal as "done" and send `/quit`.
 */
export async function runGoalAttempt(
  opts: GoalAttemptOptions,
): Promise<GoalAttemptResult> {
  const cfg = { ...DEFAULTS, ...opts };
  const startedAt = Date.now();

  // Build codex argv. No PROMPT arg — we inject /goal via stdin after warmup.
  const codexArgs: string[] = [];
  if (opts.knobs?.model) codexArgs.push("-m", opts.knobs.model);
  if (opts.knobs?.sandbox) codexArgs.push("-s", opts.knobs.sandbox);
  if (opts.knobs?.approval) codexArgs.push("-a", opts.knobs.approval);

  const eventsPath = resolve(opts.cwd, DARWIN_DIR, EVENTS_LOG);
  const tail = startTail(eventsPath);

  stderr.write(
    `darwin: spawning codex for /goal attempt (model=${opts.knobs?.model ?? "default"}, sandbox=${opts.knobs?.sandbox ?? "default"})\n`,
  );

  const child = spawn("codex", codexArgs, {
    cwd: opts.cwd,
    stdio: ["pipe", "inherit", "inherit"],
  });

  let exitCode: number | null = null;
  let codexExited = false;
  const exitPromise = new Promise<void>((res) => {
    child.on("exit", (code) => {
      exitCode = code;
      codexExited = true;
      res();
    });
  });

  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  // Wait for TUI warmup, then inject /goal. Escape any embedded newlines in
  // the goal text (codex composer would interpret them as submit).
  await sleep(cfg.tuiWarmupMs);
  if (spawnError) {
    return {
      exitReason: "error",
      durationMs: Date.now() - startedAt,
      eventCounts: tail.counts,
      exitCode: null,
    };
  }
  const oneLineGoal = opts.goal.replace(/\r?\n/g, " ").trim();
  if (child.stdin && !child.stdin.destroyed) {
    child.stdin.write(`/goal ${oneLineGoal}\n`);
  }

  // Main loop: poll tail + check stop conditions.
  let lastActivityAt = Date.now();
  let sawStopAt: number | null = null;
  let lastAssistantMessage: string | undefined;
  let exitReason: GoalExitReason | null = null;

  const POLL_MS = 250;
  while (true) {
    if (codexExited) {
      exitReason = "codex_exit";
      break;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= cfg.maxDurationMs) {
      exitReason = "time_cap";
      break;
    }

    const newEvents = tail.drain();
    for (const ev of newEvents) {
      // Track activity so quiet timer resets on tool calls / new prompts.
      if (ev.event === "pre_tool_use" || ev.event === "user_prompt_submit") {
        lastActivityAt = Date.now();
        sawStopAt = null; // continuing
      } else if (ev.event === "stop") {
        sawStopAt = Date.now();
        lastActivityAt = Date.now();
        if (typeof ev.last_assistant_message === "string") {
          lastAssistantMessage = ev.last_assistant_message;
        }
      }
    }

    // Quiet detection: only arms after we've seen at least one `stop`.
    if (sawStopAt !== null) {
      const sinceStop = Date.now() - sawStopAt;
      if (sinceStop >= cfg.quietMs) {
        exitReason = "quiet";
        break;
      }
    }

    await sleep(POLL_MS);
  }

  tail.close();
  const _ = lastActivityAt; // referenced for future telemetry; quiet detection uses sawStopAt

  // Graceful shutdown if codex still running.
  if (!codexExited) {
    stderr.write(`darwin: goal attempt ${exitReason} — sending /quit to codex\n`);
    if (child.stdin && !child.stdin.destroyed) {
      try { child.stdin.write(`/quit\n`); } catch { /* ignore */ }
    }
    const graceful = Promise.race([
      exitPromise,
      sleep(cfg.gracefulMs).then(() => "timeout" as const),
    ]);
    const winner = await graceful;
    if (winner === "timeout") {
      stderr.write("darwin: codex did not exit after /quit — SIGTERM\n");
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await Promise.race([exitPromise, sleep(2_000)]);
      if (!codexExited) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        await exitPromise;
      }
    }
  }

  const result: GoalAttemptResult = {
    exitReason: exitReason!,
    durationMs: Date.now() - startedAt,
    lastAssistantMessage,
    eventCounts: tail.counts,
    exitCode,
  };

  if (opts.trajectoryPath) {
    try {
      writeFileSync(
        opts.trajectoryPath,
        JSON.stringify(
          {
            goal: opts.goal,
            knobs: opts.knobs ?? {},
            started_at: new Date(startedAt).toISOString(),
            ended_at: new Date().toISOString(),
            ...result,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* trajectory write is best-effort */
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

interface EventRecord {
  t?: string;
  event?: string;
  last_assistant_message?: string;
  [k: string]: unknown;
}

interface Tail {
  drain(): EventRecord[];
  close(): void;
  counts: Record<string, number>;
}

/**
 * Open a JSONL file in append-only-tail mode. drain() returns lines that
 * have appeared since the last call. Lines are parsed best-effort; malformed
 * lines are skipped. If the file doesn't exist yet, drain() returns [].
 */
function startTail(path: string): Tail {
  let fd: number | null = null;
  let offset = 0;
  let leftover = "";
  const counts: Record<string, number> = {};

  function open(): void {
    if (fd !== null) return;
    if (!existsSync(path)) return;
    try {
      fd = openSync(path, "r");
      // Start at end-of-file so we only see events from this attempt.
      offset = statSync(path).size;
    } catch {
      fd = null;
    }
  }
  open();

  function drain(): EventRecord[] {
    open();
    if (fd === null) return [];

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    if (size <= offset) return [];

    const toRead = size - offset;
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, toRead, offset);
    } catch {
      return [];
    }
    offset += bytesRead;

    const chunk = leftover + buf.subarray(0, bytesRead).toString("utf-8");
    const lines = chunk.split("\n");
    leftover = lines.pop() ?? "";

    const out: EventRecord[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as EventRecord;
        const ev = typeof rec.event === "string" ? rec.event : "unknown";
        counts[ev] = (counts[ev] ?? 0) + 1;
        out.push(rec);
      } catch {
        /* malformed line — skip */
      }
    }
    return out;
  }

  function close(): void {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  }

  return { drain, close, counts };
}
