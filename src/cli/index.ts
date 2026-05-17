#!/usr/bin/env node
import { ensureHooks, setup } from "./setup.js";
import { run } from "./run.js";
import { runHook } from "./hook.js";
import { init } from "./init.js";
import { baseline } from "./baseline.js";
import { meta } from "./meta.js";
import {
  engineLabel,
  extractEngineSelection,
  formatEngineCommand,
  resolveEngineArgs,
} from "../runtime/engine.js";

const SUBCOMMANDS = new Set([
  "init",
  "baseline",
  "meta",
  "setup",
  "hook",
  "--help",
  "-h",
]);

async function main(): Promise<void> {
  const {
    engine,
    args: selectedArgs,
    engineArgs: selectedEngineArgs,
  } = extractEngineSelection(
    process.argv.slice(2),
  );
  const command = splitCommand(selectedArgs);
  const engineArgs = resolveEngineArgs(engine, [
    ...selectedEngineArgs,
    ...command.leadingEngineArgs,
  ]);
  const first = command.first;
  const rest = command.rest;

  // Explicit subcommands.
  switch (first) {
    case "init":
      await init(engine, engineArgs);
      return;
    case "baseline":
      await baseline(engine, engineArgs);
      return;
    case "meta":
      await meta(rest, engine, engineArgs);
      return;
    case "setup":
      setup();
      return;
    case "hook":
      await runHook(rest);
      return;
    case "--help":
    case "-h":
      printUsage(engine, engineArgs);
      return;
  }

  // Default: auto-install hooks if missing, then spawn the selected engine with
  // passthrough args.
  if (ensureHooks()) {
    process.stderr.write("darwin: installed .codex/hooks.json\n");
  }
  const args = first === undefined ? [] : [first, ...rest];
  const code = await run(args, engine, engineArgs);
  process.exit(code);
}

function splitCommand(args: string[]): {
  first: string | undefined;
  rest: string[];
  leadingEngineArgs: string[];
} {
  const idx = args.findIndex((arg) => SUBCOMMANDS.has(arg));
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

function printUsage(
  engine = extractEngineSelection([]).engine,
  engineArgs = resolveEngineArgs(
    extractEngineSelection([]).engine,
    extractEngineSelection([]).engineArgs,
  ),
): void {
  console.log(`darwin — meta-harness on-ramp (wraps Codex or OMX)

usage:
  darwin [agent args...]         auto-install hooks, then launch selected engine
  darwin init                    start a new meta-loop project (interview)
  darwin baseline                run the task once, record initial score
  darwin meta [--iterations N] [--duration 90s|30m|2h|1d] [--interactive]
                                 propose → execute → score → repeat
                                 (default: unbounded; runs until user stops or proposer stuck)
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

selected/default engine: ${engineLabel(engine)}
selected/default command: ${formatEngineCommand(engine, engineArgs)}
`);
}

main().catch((err) => {
  process.stderr.write(`darwin: ${err}\n`);
  process.exit(1);
});
