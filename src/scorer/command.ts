import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { ScorerSpec } from "../spec/parse.js";
import {
  captureBoundedOutput,
  createBoundedOutputCapture,
  resolvePositiveInt,
} from "../runtime/diagnostics.js";
import { terminateProcessTree } from "../runtime/process-tree.js";
import type { ScoreResult } from "./types.js";

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutParseBufferTruncated: boolean;
  stderrParseBufferTruncated: boolean;
  timedOut: boolean;
}

export interface ScorerCommandOptions {
  timeoutMsRaw?: string;
  parseBufferCharsRaw?: string;
}

const DEFAULT_SCORER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SCORER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SCORER_PARSE_BUFFER_CHARS = 1_000_000;
const MAX_SCORER_PARSE_BUFFER_CHARS = 5_000_000;

export async function commandScorer(
  spec: ScorerSpec,
  runDir: string,
  options: ScorerCommandOptions = {},
): Promise<ScoreResult> {
  if (!spec.command?.trim()) {
    return { score: null, note: "command scorer has no command configured" };
  }

  const result = await runScorerCommand(spec.command, runDir, "command", options);
  const parsed = parseCommandScore(result, spec.parse);
  const exitNote = formatExit(result);
  const parseBufferNote = formatParseBufferNote(result);
  if (parsed === null) {
    return {
      score: null,
      note: `command scorer could not parse a numeric score (${exitNote}${parseBufferNote})`,
    };
  }

  return {
    score: parsed,
    note: `command scorer parsed score ${parsed} (${exitNote})`,
  };
}

export async function runScorerCommand(
  command: string,
  runDir: string,
  artifactPrefix: string,
  options: ScorerCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = resolveScorerTimeoutMs(
    options.timeoutMsRaw ?? process.env.DARWIN_SCORER_TIMEOUT_MS,
  );
  const parseBufferLimit = resolveScorerParseBufferLimit(
    options.parseBufferCharsRaw ?? process.env.DARWIN_SCORER_PARSE_BUFFER_CHARS,
  );
  const stdoutPath = join(runDir, `${artifactPrefix}.stdout.txt`);
  const stderrPath = join(runDir, `${artifactPrefix}.stderr.txt`);
  const stdoutStream = createWriteStream(stdoutPath);
  const stderrStream = createWriteStream(stderrPath);
  const artifactsFinished = Promise.all([
    waitForFinish(stdoutStream),
    waitForFinish(stderrStream),
  ]);
  void artifactsFinished.catch(() => undefined);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DARWIN_PROJECT_DIR: process.cwd(),
        DARWIN_RUN_DIR: runDir,
      },
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const stdoutCapture = createBoundedOutputCapture();
    const stderrCapture = createBoundedOutputCapture();
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    child.stdout.on("data", (chunk: string) => {
      captureBoundedOutput(stdoutCapture, chunk, parseBufferLimit);
    });
    child.stderr.on("data", (chunk: string) => {
      captureBoundedOutput(stderrCapture, chunk, parseBufferLimit);
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, "SIGTERM", child.kill.bind(child));
      killTimer = setTimeout(() => {
        terminateProcessTree(child.pid, "SIGKILL", child.kill.bind(child));
      }, 2_000);
    }, timeoutMs);
    child.on("error", (err) => {
      cleanupTimers();
      stdoutStream.destroy();
      stderrStream.destroy();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanupTimers();
      void artifactsFinished.then(
        () => resolve({
          code: timedOut ? 124 : code,
          signal,
          stdout: stdoutCapture.head,
          stderr: stderrCapture.head,
          stdoutTail: stdoutCapture.tail,
          stderrTail: stderrCapture.tail,
          stdoutParseBufferTruncated: stdoutCapture.truncated,
          stderrParseBufferTruncated: stderrCapture.truncated,
          timedOut,
        }),
        reject,
      );
    });
  });

  writeFileSync(
    join(runDir, `${artifactPrefix}.exit.json`),
    JSON.stringify(
      {
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        stdoutParseBufferTruncated: result.stdoutParseBufferTruncated,
        stderrParseBufferTruncated: result.stderrParseBufferTruncated,
      },
      null,
      2,
    ) + "\n",
  );

  return result;
}

export function parseCommandScore(
  result: CommandResult,
  parseRule = "first_number",
): number | null {
  const rule = parseRule.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (rule === "exit_code" || rule === "exitcode") return result.code;

  const useTail = rule === "last_number" || rule === "last" || rule === "final_number";
  const stdout = useTail ? result.stdoutTail : result.stdout;
  const stderr = useTail ? result.stderrTail : result.stderr;
  const output = stdout.trim().length > 0 ? stdout : `${stdout}\n${stderr}`;
  const numbers = output.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!numbers || numbers.length === 0) return null;

  const selected = useTail ? numbers[numbers.length - 1] : numbers[0];
  const parsed = Number(selected);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatExit(result: CommandResult): string {
  if (result.timedOut) return "timeout";
  return result.signal
    ? `signal=${result.signal}`
    : `exit=${result.code ?? "unknown"}`;
}

export function formatParseBufferNote(result: CommandResult): string {
  const streams = [
    result.stdoutParseBufferTruncated ? "stdout" : "",
    result.stderrParseBufferTruncated ? "stderr" : "",
  ].filter(Boolean);
  if (streams.length === 0) return "";

  const streamList = streams.join("/");
  return `; ${streamList} parse buffer truncated; full output is in scorer artifacts; adjust parse rule or DARWIN_SCORER_PARSE_BUFFER_CHARS if needed`;
}

function waitForFinish(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

export function resolveScorerParseBufferLimit(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_SCORER_PARSE_BUFFER_CHARS, MAX_SCORER_PARSE_BUFFER_CHARS);
}

export function resolveScorerTimeoutMs(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_SCORER_TIMEOUT_MS, MAX_SCORER_TIMEOUT_MS);
}
