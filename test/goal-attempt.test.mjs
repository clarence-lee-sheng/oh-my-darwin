import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildExecGoalPrompt,
  buildInitialGoalPrompt,
  runGoalAttempt,
} from "../dist/runtime/goal-attempt.js";

test("goal attempt prompts use bounded duration text", () => {
  assert.match(
    buildExecGoalPrompt("ship it", 999),
    /external Darwin time cap is about <1s\./,
  );
  assert.match(
    buildInitialGoalPrompt(".darwin/runs/iter-1/goal.md", 1500),
    /Darwin will stop this attempt after about 2s or after/,
  );
});

test("runGoalAttempt starts codex with an initial /goal prompt and auto-terminates after quiet", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-initial-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const events = path.join(process.cwd(), '.darwin', 'events.jsonl');
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2), null, 2));
setTimeout(() => {
  fs.appendFileSync(events, JSON.stringify({ event: 'stop', last_assistant_message: 'initial goal complete' }) + '\\n');
}, 50);
process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(process.cwd(), 'terminated.txt'), 'yes');
  process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const trajectoryPath = join(cwd, ".darwin", "runs", "iter-1", "trajectory.json");
    const result = await runGoalAttempt({
      cwd,
      engine: "codex",
      engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      goal: "line one\nline two",
      maxDurationMs: 5000,
      quietMs: 100,
      gracefulMs: 1000,
      trajectoryPath,
      runner: "initial",
    });
    assert.equal(result.exitReason, "quiet");
    assert.equal(result.eventCounts.stop, 1);
    assert.equal(result.lastAssistantMessage, "initial goal complete");

    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8"));
    assert.notEqual(argv[0], "exec");
    assert.ok(argv.includes("-c"), argv.join(" "));
    assert.ok(argv.includes("features.goals=true"), argv.join(" "));
    assert.ok(argv.includes("features.hooks=true"), argv.join(" "));
    assert.ok(argv.some((arg) => /hooks\.Stop=.*hook\.js' stop/.test(arg)), argv.join(" "));
    const prompt = argv.at(-1);
    assert.match(prompt, /^\/goal Read the goal details in \.darwin\/runs\/iter-1\/goal\.md/);
    assert.doesNotMatch(prompt, /line two/);

    const goalFile = readFileSync(join(cwd, ".darwin", "runs", "iter-1", "goal.md"), "utf8");
    assert.match(goalFile, /line one\nline two/);
    assert.match(goalFile, /max duration: 5s/);
    assert.match(goalFile, /quiet window after last stop event: <1s/);
    assert.match(readFileSync(trajectoryPath, "utf8"), /"mode": "initial"/);
    assert.equal(readFileSync(join(cwd, "terminated.txt"), "utf8"), "yes");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runGoalAttempt can drive a fake codex through legacy slash pty mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-attempt-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const events = path.join(process.cwd(), '.darwin', 'events.jsonl');
process.stdin.setEncoding('utf8');
let sawGoal = false;
process.stdin.on('data', (chunk) => {
  if (!sawGoal && chunk.includes('/goal')) {
    sawGoal = true;
    fs.appendFileSync(events, JSON.stringify({ event: 'stop', last_assistant_message: 'fake goal complete' }) + '\\n');
  }
  if (chunk.includes('/quit')) process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const result = await runGoalAttempt({
      cwd,
      engine: "codex",
      engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      goal: "say done",
      maxDurationMs: 5000,
      quietMs: 200,
      gracefulMs: 1000,
      tuiWarmupMs: 50,
      trajectoryPath: join(cwd, ".darwin", "trajectory.json"),
      runner: "slash",
    });
    assert.equal(result.exitReason, "quiet");
    assert.equal(result.eventCounts.stop, 1);
    assert.equal(result.lastAssistantMessage, "fake goal complete");
    assert.match(readFileSync(join(cwd, ".darwin", "trajectory.json"), "utf8"), /fake goal complete/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runGoalAttempt slash mode suppresses raw pty output when parent is non-TTY", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-slash-quiet-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const events = path.join(process.cwd(), '.darwin', 'events.jsonl');
process.stdout.write('SLASH_TRANSCRIPT_MARKER stdout\\n');
process.stderr.write('SLASH_TRANSCRIPT_MARKER stderr\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('/goal')) {
    fs.appendFileSync(events, JSON.stringify({ event: 'stop', last_assistant_message: 'done' }) + '\\n');
  }
  if (chunk.includes('/quit')) process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const moduleUrl = new URL("../dist/runtime/goal-attempt.js", import.meta.url).href;
  const script = `
import { runGoalAttempt } from ${JSON.stringify(moduleUrl)};
const result = await runGoalAttempt({
  cwd: ${JSON.stringify(cwd)},
  engine: "codex",
  engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  goal: "reply READY",
  maxDurationMs: 3000,
  quietMs: 50,
  gracefulMs: 100,
  tuiWarmupMs: 50,
  runner: "slash",
});
console.log("RESULT:" + result.exitReason + ":" + result.lastAssistantMessage);
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:quiet:done/);
  assert.doesNotMatch(proc.stdout, /SLASH_TRANSCRIPT_MARKER/);
  assert.doesNotMatch(proc.stderr, /SLASH_TRANSCRIPT_MARKER/);
  assert.match(proc.stderr, /darwin: goal attempt quiet - sending \/quit to codex/);
  assert.doesNotMatch(proc.stderr, /[^\x00-\x7F]/);
});

test("runGoalAttempt exec mode falls back from missing OMX to Codex", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-fallback-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
last=""
hooks_disabled=0
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--disable" ]; then
    shift
    if [ "$1" = "hooks" ]; then
      hooks_disabled=1
    fi
  fi
  if [ "$1" = "--output-last-message" ]; then
    shift
    last="$1"
  fi
  shift || break
done
if [ "$hooks_disabled" != "1" ]; then
  printf 'hooks were not disabled for exec goal attempt\\n' >&2
  exit 13
fi
if [ -n "$last" ]; then
  printf READY > "$last"
fi
cat >/dev/null
exit 0
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    const trajectoryPath = join(cwd, ".darwin", "trajectory-fallback.json");
    const result = await runGoalAttempt({
      cwd,
      engine: "omx",
      engineArgs: ["--madmax", "--xhigh"],
      goal: "reply READY",
      maxDurationMs: 3000,
      gracefulMs: 100,
      trajectoryPath,
      runner: "exec",
    });
    assert.equal(result.exitReason, "engine_exit");
    assert.equal(result.lastAssistantMessage, "READY");
    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8"));
    assert.equal(trajectory.engine, "codex");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runGoalAttempt exec mode reports nonzero engine exit as error", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-nonzero-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
exit 7
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    const result = await runGoalAttempt({
      cwd,
      engine: "codex",
      engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      goal: "fail intentionally",
      maxDurationMs: 3000,
      gracefulMs: 100,
      runner: "exec",
    });
    assert.equal(result.exitReason, "error");
    assert.equal(result.exitCode, 7);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runGoalAttempt exec mode suppresses raw engine transcript output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-quiet-exec-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
last=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    last="$1"
  fi
  shift || break
done
printf 'FULL TRANSCRIPT MARKER stdout\\n'
printf 'FULL TRANSCRIPT MARKER stderr\\n' >&2
if [ -n "$last" ]; then
  printf READY > "$last"
fi
cat >/dev/null
exit 0
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const moduleUrl = new URL("../dist/runtime/goal-attempt.js", import.meta.url).href;
  const script = `
import { runGoalAttempt } from ${JSON.stringify(moduleUrl)};
const result = await runGoalAttempt({
  cwd: ${JSON.stringify(cwd)},
  engine: "codex",
  engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  goal: "reply READY",
  maxDurationMs: 3000,
  gracefulMs: 100,
  runner: "exec",
});
console.log("RESULT:" + result.exitReason + ":" + result.lastAssistantMessage);
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:engine_exit:READY/);
  assert.doesNotMatch(proc.stdout, /FULL TRANSCRIPT MARKER/);
  assert.doesNotMatch(proc.stderr, /FULL TRANSCRIPT MARKER/);
});

test("runGoalAttempt exec mode surfaces bounded stderr tail on engine failure", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-error-tail-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
printf '%05000dENGINE_FAILURE_MARKER\\n' 0 >&2
exit 7
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const moduleUrl = new URL("../dist/runtime/goal-attempt.js", import.meta.url).href;
  const script = `
import { runGoalAttempt } from ${JSON.stringify(moduleUrl)};
const result = await runGoalAttempt({
  cwd: ${JSON.stringify(cwd)},
  engine: "codex",
  engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  goal: "fail intentionally",
  maxDurationMs: 3000,
  gracefulMs: 100,
  runner: "exec",
});
console.log("RESULT:" + result.exitReason + ":" + result.exitCode);
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:error:7/);
  assert.match(proc.stderr, /ENGINE_FAILURE_MARKER/);
  assert.ok(proc.stderr.length < 4_800, proc.stderr);
});

test("runGoalAttempt exec mode returns time_cap for stuck engines", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-time-cap-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "", "utf8");
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${oldPath ?? ""}`;
  try {
    const result = await runGoalAttempt({
      cwd,
      engine: "codex",
      engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      goal: "hang intentionally",
      maxDurationMs: 50,
      gracefulMs: 50,
      runner: "exec",
    });
    assert.equal(result.exitReason, "time_cap");
    assert.equal(result.exitCode, null);
  } finally {
    process.env.PATH = oldPath;
  }
});
