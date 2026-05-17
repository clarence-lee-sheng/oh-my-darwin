import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGoalAttempt } from "../dist/runtime/goal-attempt.js";

test("runGoalAttempt drives a fake codex through the pty bridge and exits on quiet", async () => {
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
    });
    assert.equal(result.exitReason, "quiet");
    assert.equal(result.eventCounts.stop, 1);
    assert.equal(result.lastAssistantMessage, "fake goal complete");
    assert.match(readFileSync(join(cwd, ".darwin", "trajectory.json"), "utf8"), /fake goal complete/);
  } finally {
    process.env.PATH = oldPath;
  }
});
