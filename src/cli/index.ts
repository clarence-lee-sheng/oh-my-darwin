#!/usr/bin/env node
import { formatErrorSummary } from "../runtime/diagnostics.js";
import { writeCliError, writeCliOutput } from "./display.js";

const SUBCOMMANDS = new Set([
  "init",
  "baseline",
  "meta",
  "status",
  "projects",
  "list",
  "capabilities",
  "setup",
  "hook",
  "--help",
  "-h",
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawCommand = splitCommand(argv);
  switch (rawCommand.first) {
    case "status": {
      const { status } = await import("./status.js");
      await status();
      return;
    }
    case "projects":
    case "list": {
      const { projects } = await import("./projects.js");
      projects();
      return;
    }
    case "capabilities": {
      const { capabilities } = await import("./capabilities.js");
      await capabilities();
      return;
    }
    case "setup": {
      const { setup } = await import("./setup.js");
      setup();
      return;
    }
    case "hook": {
      const { runHook } = await import("./hook.js");
      await runHook(rawCommand.rest);
      return;
    }
    case "--help":
    case "-h": {
      const summary = await helpEngineSummary(argv);
      printUsage(summary.label, summary.command);
      return;
    }
  }

  const {
    extractEngineSelection,
    resolveEngineArgs,
  } = await import("../runtime/engine.js");
  const {
    engine,
    args: selectedArgs,
    engineArgs: selectedEngineArgs,
  } = extractEngineSelection(argv);
  const command = splitCommand(selectedArgs);
  const engineArgs = resolveEngineArgs(engine, [
    ...selectedEngineArgs,
    ...command.leadingEngineArgs,
  ]);
  const first = command.first;
  const rest = command.rest;

  // Explicit subcommands.
  switch (first) {
    case "init": {
      const { init } = await import("./init.js");
      await init(engine, engineArgs);
      return;
    }
    case "baseline": {
      const { baseline } = await import("./baseline.js");
      await baseline(engine, engineArgs);
      return;
    }
    case "meta": {
      const { meta } = await import("./meta.js");
      await meta(rest, engine, engineArgs);
      return;
    }
  }

  // Default: auto-install hooks if missing, then spawn the selected engine with
  // passthrough args.
  const { ensureHooks } = await import("./setup.js");
  if (ensureHooks()) {
    writeCliError("darwin: installed .codex/hooks.json");
  }
  const args = first === undefined ? [] : [first, ...rest];
  const { run } = await import("./run.js");
  const code = await run(args, engine, engineArgs);
  process.exit(code);
}

function splitCommand(args: string[]): {
  first: string | undefined;
  rest: string[];
  leadingEngineArgs: string[];
} {
  const idx = subcommandIndex(args);
  if (idx > 0) {
    return {
      first: args[idx],
      rest: args.slice(idx + 1),
      leadingEngineArgs: args.slice(0, idx),
    };
  }
  return {
    first: args[0],
    rest: args.slice(1),
    leadingEngineArgs: [],
  };
}

function subcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--engine" || arg === "--engine-arg" || arg === "--engine-args") {
      i++;
      continue;
    }
    if (SUBCOMMANDS.has(arg)) return i;
  }
  return -1;
}

async function helpEngineSummary(
  argv: string[],
): Promise<{ label: string; command: string }> {
  try {
    const {
      engineLabel,
      extractEngineSelection,
      formatEngineCommandForLog,
      resolveEngineArgs,
    } = await import("../runtime/engine.js");
    const selected = extractEngineSelection(argv);
    const engineArgs = resolveEngineArgs(selected.engine, selected.engineArgs);
    return {
      label: engineLabel(selected.engine),
      command: formatEngineCommandForLog(selected.engine, engineArgs),
    };
  } catch (err) {
    return {
      label: "invalid engine configuration",
      command: `unavailable (${formatErrorSummary(err)})`,
    };
  }
}

function printUsage(
  selectedEngineLabel: string,
  selectedEngineCommand: string,
): void {
  writeCliOutput(`darwin - meta-harness on-ramp (wraps Codex or OMX)

usage:
  darwin [agent args...]         auto-install hooks, then launch selected engine
  darwin init                    start a new meta-loop project (interview)
  darwin baseline                run the task once, record initial score
  darwin meta [--iterations N] [--duration 90s|30m|2h|1d] [--interactive]
              [--goal-mode|--harness-mode] [--attempt-max 30m] [--attempt-quiet 60s]
              [--goal-runner initial|exec|slash]
              [--proposer-runner exec|interactive]
              [--interactive-proposer|--interactive-propose]
                                 propose -> execute -> score -> repeat
                                 (default: unbounded; runs until user stops or proposer stuck)
                                 default mode: goal-mode
                                 --harness-mode: use harness proposal/execution instead
                                 proposer default: interactive terminal session
                                              (use --proposer-runner exec for
                                              quiet bounded automation)
                                 --interactive-proposer / --interactive-propose:
                                              aliases for the default
                                 --goal-mode: explicit spelling of the default;
                                              use Codex /goal as attempt primitive
                                              (proposer outputs goal+knobs instead of a harness)
                                              honors --omx/--codex engine selection
                                 --goal-runner: default initial /goal prompt;
                                                exec = non-slash automation;
                                                slash = legacy TUI /goal injection
  darwin status                  show project/frontier/capability status
  darwin projects                list ~/.darwin registered projects
  darwin capabilities            list active/stale project capabilities
  darwin setup                   (re)install .codex/hooks.json
  darwin hook <event>            handler invoked by .codex/hooks.json

engine selection:
  --engine codex|omx             choose the agent CLI for this invocation
  --codex / --omx                shortcuts for --engine codex / --engine omx
  DARWIN_ENGINE=codex|omx        default engine when no flag is passed (omx by default)
  --engine-arg <arg>             prepend one arg to internal engine launches
  --engine-args "<args>"          prepend shell-like args to internal launches
  DARWIN_ENGINE_ARGS="..."       override default internal engine args

defaults:
  omx --madmax --xhigh           used when no engine/args are selected
  codex --dangerously-bypass-approvals-and-sandbox
                                 used for explicit codex and omx fallback

examples:
  darwin baseline
  darwin --codex baseline
  darwin --codex --sandbox read-only baseline
  DARWIN_ENGINE=omx DARWIN_ENGINE_ARGS="--madmax --xhigh" darwin meta

selected/default engine: ${selectedEngineLabel}
selected/default command: ${selectedEngineCommand}
`);
}

main().catch((err) => {
  writeCliError(`darwin: ${formatErrorSummary(err)}`);
  process.exit(1);
});
