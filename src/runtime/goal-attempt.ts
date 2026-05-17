import { spawn } from "node:child_process";
import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stderr } from "node:process";
import { DARWIN_DIR, EVENTS_LOG } from "../cli/constants.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineEnv,
  engineExecArgs,
  engineInteractiveArgs,
  formatEngineCommand,
  hasApprovalArg,
  hasBypassApprovalsAndSandbox,
  hasSandboxArg,
  resolveEngineArgs,
  type EngineName,
} from "./engine.js";

export type GoalRunner = "exec" | "slash";

export type GoalExitReason =
  | "quiet"          // no new tool/prompt activity within quietMs after last `stop`
  | "time_cap"       // hit hard wall-clock cap
  | "engine_exit"    // selected engine exited on its own
  | "codex_exit"     // legacy name for interactive codex/omx TUI exit
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
  /** cwd for the engine child (and where .darwin/events.jsonl lives). */
  cwd: string;
  /** Agent engine used for the interactive slash-goal attempt. */
  engine?: EngineName;
  /** Engine/launch args selected by Darwin's CLI config. */
  engineArgs?: string[];
  /**
   * Execution primitive. `exec` is the stable default for automation; `slash`
   * keeps the original interactive `/goal` injection path for manual debugging.
   */
  runner?: GoalRunner;
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
  runner: "exec" as GoalRunner,
  maxDurationMs: 30 * 60 * 1000,
  quietMs: 60_000,
  gracefulMs: 5_000,
  tuiWarmupMs: 1_500,
};

/**
 * Run one slash-goal attempt. Spawns the selected engine interactively (TUI
 * visible to the user), injects `/goal <text>` once the TUI is ready, then watches
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
  const engine = opts.engine ?? DEFAULT_ENGINE;
  const selectedEngineArgs = opts.engineArgs ?? resolveEngineArgs(engine);

  if (cfg.runner === "exec") {
    return runExecGoalAttempt(opts, cfg, engine, selectedEngineArgs, startedAt);
  }

  // Build engine argv. No PROMPT arg — we inject /goal via stdin after warmup.
  const goalArgs = goalKnobArgs(opts.knobs, selectedEngineArgs);
  // Preserve scrollback and make scripted `/goal` injection easier to debug.
  goalArgs.push("--no-alt-screen");
  const launchArgs = engineInteractiveArgs(engine, selectedEngineArgs, goalArgs);

  const eventsPath = resolve(opts.cwd, DARWIN_DIR, EVENTS_LOG);
  const tail = startTail(eventsPath);

  stderr.write(
    `darwin: spawning ${formatEngineCommand(engine, launchArgs)} for /goal attempt (model=${opts.knobs?.model ?? "default"}, sandbox=${opts.knobs?.sandbox ?? "default"})\n`,
  );

  const launch = ptyLaunchCommand(engineCommand(engine), launchArgs);
  if (launch.ptyWrapped) {
    stderr.write(`darwin: wrapping ${engineCommand(engine)} in a pseudo-terminal for /goal automation (${launch.command})\n`);
  }
  const child = spawn(launch.command, launch.args, {
    cwd: opts.cwd,
    env: engineEnv(engine),
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
            engine,
            engine_args: selectedEngineArgs,
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

async function runExecGoalAttempt(
  opts: GoalAttemptOptions,
  cfg: typeof DEFAULTS & GoalAttemptOptions,
  engine: EngineName,
  selectedEngineArgs: string[],
  startedAt: number,
): Promise<GoalAttemptResult> {
  const tmp = mkdtempSync(join(tmpdir(), "darwin-goal-attempt-"));
  const lastMsgPath = join(tmp, "last.txt");
  const eventsPath = resolve(opts.cwd, DARWIN_DIR, EVENTS_LOG);
  const tail = startTail(eventsPath);
  const execPrompt = buildExecGoalPrompt(opts.goal, cfg.maxDurationMs);
  const execArgs = engineExecArgs(engine, selectedEngineArgs, [
    ...goalKnobArgs(opts.knobs, selectedEngineArgs),
    "--skip-git-repo-check",
    "--output-last-message",
    lastMsgPath,
    "--color",
    "never",
    "-",
  ]);

  stderr.write(
    `darwin: spawning ${formatEngineCommand(engine, execArgs)} for goal attempt (runner=exec, model=${opts.knobs?.model ?? "default"}, sandbox=${opts.knobs?.sandbox ?? "default"})\n`,
  );

  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let timedOut = false;

  try {
    const child = spawn(engineCommand(engine), execArgs, {
      cwd: opts.cwd,
      env: engineEnv(engine),
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", (e) => {
      spawnError = e;
    });
    child.stdin?.end(execPrompt + "\n");

    const exitPromise = new Promise<void>((res) => {
      child.on("exit", (code) => {
        exitCode = code;
        res();
      });
    });

    const timeout = sleep(cfg.maxDurationMs).then(() => "timeout" as const);
    const winner = await Promise.race([exitPromise.then(() => "exit" as const), timeout]);
    if (winner === "timeout") {
      timedOut = true;
      stderr.write("darwin: goal attempt time_cap — terminating exec runner\n");
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await Promise.race([exitPromise, sleep(cfg.gracefulMs)]);
      if (exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        await exitPromise;
      }
    }

    const lastAssistantMessage = existsSync(lastMsgPath)
      ? readFileSync(lastMsgPath, "utf-8")
      : undefined;
    const result: GoalAttemptResult = {
      exitReason: spawnError ? "error" : timedOut ? "time_cap" : "engine_exit",
      durationMs: Date.now() - startedAt,
      lastAssistantMessage,
      eventCounts: tail.counts,
      exitCode,
    };
    writeTrajectory(opts, {
      engine,
      selectedEngineArgs,
      runner: "exec",
      startedAt,
      result,
    });
    return result;
  } finally {
    tail.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function goalKnobArgs(
  knobs: GoalAttemptOptions["knobs"],
  selectedEngineArgs: string[],
): string[] {
  const args: string[] = [];
  if (knobs?.model) args.push("-m", knobs.model);

  const bypassesApprovalsAndSandbox = hasBypassApprovalsAndSandbox(selectedEngineArgs);
  if (bypassesApprovalsAndSandbox) {
    if (knobs?.sandbox || knobs?.approval) {
      stderr.write(
        "darwin: engine args already bypass approvals/sandbox; ignoring proposed sandbox/approval knobs for this goal attempt\n",
      );
    }
    return args;
  }

  if (knobs?.sandbox) {
    if (hasSandboxArg(selectedEngineArgs)) {
      stderr.write("darwin: engine args already set sandbox; ignoring proposed sandbox knob\n");
    } else {
      args.push("-s", knobs.sandbox);
    }
  }
  if (knobs?.approval) {
    if (hasApprovalArg(selectedEngineArgs)) {
      stderr.write("darwin: engine args already set approval policy; ignoring proposed approval knob\n");
    } else {
      args.push("-a", knobs.approval);
    }
  }
  return args;
}

function buildExecGoalPrompt(goal: string, maxDurationMs: number): string {
  return `You are running inside Darwin goal-mode using the stable non-interactive exec runner. Treat the following as the exact goal objective you must autonomously pursue. Work until the goal is satisfied or until the external Darwin time cap of about ${Math.round(maxDurationMs / 1000)} seconds interrupts you. When you stop, summarize concrete actions, artifacts, evidence, and any measured outcome.\n\nGOAL:\n${goal}`;
}

function writeTrajectory(
  opts: GoalAttemptOptions,
  a: {
    engine: EngineName;
    selectedEngineArgs: string[];
    runner: GoalRunner;
    startedAt: number;
    result: GoalAttemptResult;
  },
): void {
  if (!opts.trajectoryPath) return;
  try {
    writeFileSync(
      opts.trajectoryPath,
      JSON.stringify(
        {
          engine: a.engine,
          engine_args: a.selectedEngineArgs,
          runner: a.runner,
          goal: opts.goal,
          knobs: opts.knobs ?? {},
          started_at: new Date(a.startedAt).toISOString(),
          ended_at: new Date().toISOString(),
          ...a.result,
        },
        null,
      ) + "\n",
    );
  } catch {
    /* trajectory write is best-effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function ptyLaunchCommand(command: string, args: string[]): {
  command: string;
  args: string[];
  ptyWrapped: boolean;
} {
  // Interactive Codex requires stdin to be a terminal. Darwin needs to inject
  // `/goal` programmatically, so a normal pipe triggers:
  //   Error: stdin is not a terminal
  // A Python pty bridge gives Codex a real pty while still letting Darwin write
  // scripted input to the bridge's stdin. Avoid macOS/BSD `script`: in Codex /
  // tmux-style launch environments the parent's stdio can be a socket, causing
  // `script: tcgetattr/ioctl: Operation not supported on socket`.
  if (process.platform !== "win32") {
    return {
      command: "python3",
      args: ["-c", PYTHON_PTY_BRIDGE, command, ...args],
      ptyWrapped: true,
    };
  }
  return { command, args, ptyWrapped: false };
}

const PYTHON_PTY_BRIDGE = String.raw`
import errno
import os
import pty
import select
import signal
import sys

argv = sys.argv[1:]
if not argv:
    sys.exit(2)

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

def forward_signal(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass

for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    try:
        signal.signal(_sig, forward_signal)
    except Exception:
        pass

stdin_open = True
status = None

while True:
    if status is None:
        try:
            done, maybe_status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = maybe_status
        except ChildProcessError:
            status = 0

    read_fds = [fd]
    if stdin_open:
        read_fds.append(0)

    try:
        readable, _, _ = select.select(read_fds, [], [], 0.1)
    except OSError:
        break

    if stdin_open and 0 in readable:
        data = os.read(0, 4096)
        if data:
            try:
                os.write(fd, data)
            except OSError:
                stdin_open = False
        else:
            stdin_open = False

    if fd in readable:
        try:
            data = os.read(fd, 4096)
        except OSError as e:
            if e.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not data:
            break
        os.write(1, data)

    # Once the child has exited and no pty bytes were immediately available,
    # the next read normally raises EIO. Keep looping briefly to drain output.
    if status is not None and not readable:
        break

if status is None:
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0

if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
`;

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
