#!/usr/bin/env node
import { ensureHooks, setup } from "./setup.js";
import { run } from "./run.js";
import { runHook } from "./hook.js";
import { init } from "./init.js";
import { baseline } from "./baseline.js";
import { meta } from "./meta.js";

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);

  // Explicit subcommands.
  switch (first) {
    case "init":
      await init();
      return;
    case "baseline":
      await baseline();
      return;
    case "meta":
      await meta(rest);
      return;
    case "setup":
      setup();
      return;
    case "hook":
      await runHook(rest);
      return;
    case "--help":
    case "-h":
      printUsage();
      return;
  }

  // Default: auto-install hooks if missing, then spawn Codex with passthrough args.
  if (ensureHooks()) {
    process.stderr.write("darwin: installed .codex/hooks.json\n");
  }
  const args = first === undefined ? [] : [first, ...rest];
  const code = await run(args);
  process.exit(code);
}

function printUsage(): void {
  console.log(`darwin — meta-harness on-ramp (wraps Codex CLI)

usage:
  darwin [codex args...]         auto-install hooks, then launch codex
  darwin init                    start a new meta-loop project (interview)
  darwin baseline                run the task once, record initial score
  darwin meta [--iterations N] [--duration 90s|30m|2h|1d] [--interactive]
              [--goal-mode] [--attempt-max 30m] [--attempt-quiet 60s]
                                 propose → execute → score → repeat
                                 (default: unbounded; runs until user stops or proposer stuck)
                                 --goal-mode: use Codex /goal as the attempt primitive
                                              (proposer outputs goal+knobs instead of a harness)
  darwin setup                   (re)install .codex/hooks.json
  darwin hook <event>            handler invoked by .codex/hooks.json
`);
}

main().catch((err) => {
  process.stderr.write(`darwin: ${err}\n`);
  process.exit(1);
});
