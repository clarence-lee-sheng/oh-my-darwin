import {
  DEFAULT_ENGINE,
  engineCommand,
  engineExecArgs,
  engineEnv,
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

const DEFAULT_PROPOSER_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PROPOSER_TIMEOUT_MS = 10 * 60 * 1000;
const INTERACTIVE_PROPOSER_OUTPUT_POLL_MS = 250;
const INTERACTIVE_PROPOSER_OUTPUT_SETTLE_MS = 500;
const INTERACTIVE_PROPOSER_KILL_GRACE_MS = 5_000;

export { resolveProposerRunner };
export type { ProposerRunner };

export interface InvokeProposerOptions {
  /**
   * `interactive` is the manual default. `exec` launches the
   * selected engine as quiet bounded automation.
   *
   * Interactive launches the
   * selected engine as a normal terminal session so the operator can inspect,
   * steer, or manually finish the proposal before exiting the engine.
   */
  runner?: ProposerRunner;
}

/**
 * Spawn the selected engine to generate one harness proposal. By default this
 * uses a normal interactive terminal session; callers can select the quiet
 * exec runner for bounded automation.
 *
 * Expects the proposer to write a single file at `expectedOutputPath`
 * before exiting. Returns when the engine exits successfully and the file
 * exists; rejects otherwise.
 */
export async function invokeProposer(
  promptText: string,
  expectedOutputPath: string,
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
  options: InvokeProposerOptions = {},
): Promise<void> {
  const runner = resolveProposerRunner(options.runner);
  try {
    return await invokeProposerOnce(
      promptText,
      expectedOutputPath,
      engine,
      engineArgs,
      runner,
    );
  } catch (err) {
    const fallback = fallbackEngine(engine);
    if (fallback && isEngineLaunchError(err)) {
      writeTerminalError(fallbackNotice(engine, fallback, err));
      return invokeProposerOnce(
        promptText,
        expectedOutputPath,
        fallback,
        resolveEngineArgs(fallback),
        runner,
      );
    }
    throw err;
  }
}

async function invokeProposerOnce(
  promptText: string,
  expectedOutputPath: string,
  engine: EngineName,
  engineArgs: string[],
  runner: ProposerRunner,
): Promise<void> {
  if (runner === "interactive") {
    return invokeInteractiveProposerOnce(
      promptText,
      expectedOutputPath,
      engine,
      engineArgs,
    );
  }

  const args = engineExecArgs(engine, engineArgs, [
    "--skip-git-repo-check",
    "--disable",
    "hooks",
    "--color",
    "never",
    "-",
  ]);
  const timeoutMs = resolveProposerTimeoutMs(process.env.DARWIN_PROPOSER_TIMEOUT_MS);
  writeTerminalError(
    `darwin: invoking ${formatEngineCommandForLog(engine, args)} for proposer...`,
  );

  const result = await runQuietChild({
    command: engineCommand(engine),
    args,
    cwd: process.cwd(),
    env: engineEnv(engine),
    input: promptText + "\n",
    timeoutMs,
    timeoutLabel: "proposer",
    writeStatus: writeTerminalError,
  });
  if (result.timedOut) {
    throw new Error(
      `${engineCommand(engine)} proposer timed out after ${formatDurationMs(timeoutMs)}`,
    );
  }
  if (result.code !== 0) {
    const tail = formatQuietChildStderrTail("proposer", result.stderrTail);
    if (tail) writeTerminalError(tail);
    throw new Error(`${engineCommand(engine)} exited with code ${result.code}`);
  }
  if (!fileExists(expectedOutputPath)) {
    throw new Error(
      `proposer did not write ${formatProposerOutputPathForTerminal(expectedOutputPath)}`,
    );
  }
}

async function invokeInteractiveProposerOnce(
  promptText: string,
  expectedOutputPath: string,
  engine: EngineName,
  engineArgs: string[],
): Promise<void> {
  const args = engineInteractiveArgs(engine, engineArgs);
  writeTerminalError(
    `darwin: launching ${formatEngineCommandForLog(engine, args)} <proposer prompt> for interactive proposer`,
  );
  writeTerminalError(
    `darwin: interact with the agent if needed; Darwin will continue automatically after it writes ${formatProposerOutputPathForTerminal(expectedOutputPath)}`,
  );

  const { child, exitInfo } = spawnEngine(engine, [promptText], {
    engineArgs: args,
  });

  const first = await Promise.race([
    exitInfo.then((info) => ({ kind: "exit" as const, info })),
    waitForFile(expectedOutputPath, {
      pollMs: INTERACTIVE_PROPOSER_OUTPUT_POLL_MS,
      settleMs: INTERACTIVE_PROPOSER_OUTPUT_SETTLE_MS,
    }).then(() => ({ kind: "file" as const })),
  ]);

  if (first.kind === "file") {
    writeTerminalError(
      "darwin: proposer wrote candidate; closing interactive proposer and continuing",
    );
    await terminateChildProcess(child, {
      killGraceMs: INTERACTIVE_PROPOSER_KILL_GRACE_MS,
    });
    return;
  }

  const { engine: completedEngine, code } = first.info;
  if (!fileExists(expectedOutputPath)) {
    throw new Error(
      `proposer did not write ${formatProposerOutputPathForTerminal(expectedOutputPath)}`,
    );
  }
  if (code !== 0) {
    throw new Error(`${engineCommand(completedEngine)} exited with code ${code}`);
  }
}

export function formatProposerOutputPathForTerminal(
  outputPath: string,
  cwd = process.cwd(),
): string {
  return formatPathForTerminal(outputPath, { cwd });
}

export function resolveProposerTimeoutMs(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_PROPOSER_TIMEOUT_MS, MAX_PROPOSER_TIMEOUT_MS);
}
