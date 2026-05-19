import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGoalProposerPrompt,
  formatGoalProposerAttemptsForPrompt,
  formatGoalProposerCandidatePathForTerminal,
  formatGoalProposerHint,
  formatGoalProposerTaskForPrompt,
  invokeGoalProposer,
  parseGoalCandidate,
  resolveGoalProposerTimeoutMs,
} from "../dist/proposer/goal-proposer.js";

test("goal proposer falls back from missing OMX to Codex and parses final JSON", async () => {
  const { cwd, bin } = createFakeCodex("darwin-goal-proposer-", `#!/bin/sh
last=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    last="$1"
  fi
  shift || break
done
cat >/dev/null
printf '%s' '{"goal":"reply READY","knobs":{},"rationale":"fallback smoke"}' > "$last"
exit 0
`);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    const candidate = await invokeGoalProposer("propose", cwd, {
      engine: "omx",
      engineArgs: ["--madmax", "--xhigh"],
      runner: "exec",
    });
    assert.equal(candidate.goal, "reply READY");
    assert.deepEqual(candidate.knobs, {});
    assert.equal(candidate.rationale, "fallback smoke");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("goal proposer suppresses raw exec transcript output on success", () => {
  const { cwd, bin } = createFakeCodex("darwin-goal-proposer-quiet-", `#!/bin/sh
last=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    last="$1"
  fi
  shift || break
done
cat >/dev/null
printf 'PROPOSER TRANSCRIPT MARKER stdout\\n'
printf 'PROPOSER TRANSCRIPT MARKER stderr\\n' >&2
printf '%s' '{"goal":"reply READY","knobs":{},"rationale":"quiet smoke"}' > "$last"
exit 0
`);

  const moduleUrl = new URL("../dist/proposer/goal-proposer.js", import.meta.url).href;
  const script = `
import { invokeGoalProposer } from ${JSON.stringify(moduleUrl)};
const candidate = await invokeGoalProposer("propose", ${JSON.stringify(cwd)}, {
  engine: "codex",
  engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  runner: "exec",
});
console.log("RESULT:" + candidate.goal + ":" + candidate.rationale);
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:reply READY:quiet smoke/);
  assert.doesNotMatch(proc.stdout, /PROPOSER TRANSCRIPT MARKER/);
  assert.doesNotMatch(proc.stderr, /PROPOSER TRANSCRIPT MARKER/);
});

test("goal proposer surfaces bounded stderr tail on failure", () => {
  const { cwd, bin } = createFakeCodex("darwin-goal-proposer-error-", `#!/bin/sh
cat >/dev/null
printf '%05000dPROPOSER_FAILURE_MARKER\\n' 0 >&2
exit 7
`);

  const moduleUrl = new URL("../dist/proposer/goal-proposer.js", import.meta.url).href;
  const script = `
import { invokeGoalProposer } from ${JSON.stringify(moduleUrl)};
try {
  await invokeGoalProposer("propose", ${JSON.stringify(cwd)}, {
    engine: "codex",
    engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    runner: "exec",
  });
  console.log("UNEXPECTED_SUCCESS");
} catch (error) {
  console.log("RESULT:" + error.message);
}
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:codex exec exited 7/);
  assert.match(proc.stderr, /PROPOSER_FAILURE_MARKER/);
  assert.ok(proc.stderr.length < 4_800, proc.stderr);
});

test("goal proposer times out stuck engines", () => {
  const { cwd, bin } = createFakeCodex("darwin-goal-proposer-timeout-", `#!/bin/sh
cat >/dev/null
sleep 10
`);

  const moduleUrl = new URL("../dist/proposer/goal-proposer.js", import.meta.url).href;
  const script = `
import { invokeGoalProposer } from ${JSON.stringify(moduleUrl)};
try {
  await invokeGoalProposer("propose", ${JSON.stringify(cwd)}, {
    engine: "codex",
    engineArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    runner: "exec",
  });
  console.log("UNEXPECTED_SUCCESS");
} catch (error) {
  console.log("RESULT:" + error.message);
}
`;
  const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DARWIN_GOAL_PROPOSER_TIMEOUT_MS: "50",
      PATH: `${bin}:/usr/bin:/bin`,
    },
    timeout: 5_000,
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /RESULT:codex goal proposer timed out after <1s/);
  assert.match(proc.stderr, /darwin: goal proposer timed out after/);
});

test("goal proposer interactive runner writes candidate file and auto-closes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-proposer-interactive-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  const candidatePath = join(cwd, "candidate.json");
  const terminatedPath = join(cwd, "terminated.txt");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "exec") process.exit(42);
const prompt = process.argv.slice(2).join("\\n");
const marker = prompt.match(/exact file path:\\n([^\\n]+)/);
if (!marker) process.exit(43);
fs.writeFileSync(marker[1], '{"goal":"reply READY","knobs":{},"rationale":"interactive smoke"}');
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(terminatedPath)}, "yes\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const candidate = await invokeGoalProposer("propose", cwd, {
      engine: "codex",
      engineArgs: [],
      runner: "interactive",
      outputPath: candidatePath,
    });
    assert.equal(candidate.goal, "reply READY");
    assert.equal(candidate.rationale, "interactive smoke");
  } finally {
    process.env.PATH = oldPath;
  }

  assert.match(readFileSync(candidatePath, "utf8"), /reply READY/);
  assert.equal(readFileSync(terminatedPath, "utf8"), "yes\n");
});

test("goal proposer candidate paths are relative, single-line, and bounded for terminal output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-proposer-path-"));
  const candidatePath = join(
    cwd,
    ".darwin",
    "runs",
    `iter-1\n${"x".repeat(500)}`,
    "candidate.json",
  );

  const formatted = formatGoalProposerCandidatePathForTerminal(candidatePath, cwd);

  assert.match(formatted, /^\.darwin\/runs\/iter-1 x+/);
  assert.doesNotMatch(formatted, new RegExp(escapeRegExp(cwd)));
  assert.doesNotMatch(formatted, /\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 160);
});

test("goal proposer missing candidate errors use formatted paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-proposer-missing-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  const candidatePath = join(
    cwd,
    ".darwin",
    "runs",
    `iter-1\n${"x".repeat(220)}`,
    "candidate.json",
  );
  writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv[2] === "exec") process.exit(42);
process.exit(0);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    await assert.rejects(
      () => invokeGoalProposer("propose", cwd, {
        engine: "codex",
        engineArgs: [],
        runner: "interactive",
        outputPath: candidatePath,
      }),
      (err) => {
        assert.match(err.message, /^goal proposer did not write \.darwin\/runs\/iter-1 x+/);
        assert.doesNotMatch(err.message, new RegExp(escapeRegExp(cwd)));
        assert.doesNotMatch(err.message, /\n/);
        assert.doesNotMatch(err.message, /x{230}/);
        assert.ok(err.message.length <= "goal proposer did not write ".length + 240);
        return true;
      },
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("goal proposer prompt bounds prior attempts and advisory hint", () => {
  const attempts = Array.from({ length: 6 }, (_, i) => ({
    attempt_id: i === 1 ? `iter-2\n${"a".repeat(1000)}` : `iter-${i + 1}`,
    score: i,
    outcome: i === 1 ? `scored\n${"o".repeat(1000)}` : "scored",
    goal: `goal line\n${"x".repeat(1000)}`,
    rationale: `why line\n${"y".repeat(1000)}`,
  }));
  const history = formatGoalProposerAttemptsForPrompt(attempts);
  const hint = formatGoalProposerHint(`hint line\n${"z".repeat(2000)}`);
  const prompt = buildGoalProposerPrompt({
    task: "short task",
    frontierAttempt: `frontier\n${"f".repeat(1000)}`,
    frontierScore: 6,
    priorAttempts: attempts,
    priorHint: `hint line\n${"z".repeat(2000)}`,
  });

  assert.doesNotMatch(history, /iter-1/);
  assert.match(history, /^- iter-2 a+/m);
  assert.match(history, /scored o+\.\.\./);
  assert.match(history, /goal: goal line x+/);
  assert.match(history, /why: why line y+/);
  assert.doesNotMatch(history, /iter-2\na/);
  assert.doesNotMatch(history, /scored\no/);
  assert.doesNotMatch(history, /goal line\nx/);
  assert.doesNotMatch(history, /why line\ny/);
  assert.doesNotMatch(history, /a{300}/);
  assert.doesNotMatch(history, /o{300}/);
  assert.doesNotMatch(history, /x{300}/);
  assert.doesNotMatch(history, /y{300}/);

  assert.match(hint ?? "", /^hint line z+/);
  assert.doesNotMatch(hint ?? "", /hint line\n/);
  assert.ok((hint ?? "").length <= 1_000);

  assert.match(prompt, /ADVISORY HINT FROM PRIOR ATTEMPT:\nhint line z+/);
  assert.match(prompt, /attempt_id: frontier f+\.\.\./);
  assert.doesNotMatch(prompt, /frontier\nf/);
  assert.doesNotMatch(prompt, /[^\x00-\x7F]/);
  assert.doesNotMatch(prompt, /z{1200}/);
});

test("goal proposer prompt bounds task text with artifact pointer", () => {
  const task = formatGoalProposerTaskForPrompt(`task line\n${"x".repeat(25_000)}`);
  const prompt = buildGoalProposerPrompt({
    task: `task line\n${"x".repeat(25_000)}`,
    frontierAttempt: "iter-1",
    frontierScore: 1,
    priorAttempts: [],
  });

  assert.match(task, /^task line/);
  assert.match(task, /\.\.\.\[truncated; full task saved to \.darwin\/meta-spec\.md\]$/);
  assert.ok(task.length < 21_000);
  assert.doesNotMatch(task, /x{21_000}/);

  assert.match(prompt, /TASK:\ntask line\nx+/);
  assert.match(prompt, /\.\.\.\[truncated; full task saved to \.darwin\/meta-spec\.md\]/);
  assert.doesNotMatch(prompt, /x{21_000}/);
});

test("parseGoalCandidate summarizes invalid JSON errors", () => {
  assert.throws(
    () => parseGoalCandidate("{"),
    (err) => {
      assert.match(err.message, /^proposer output is not valid JSON: SyntaxError: /);
      assert.doesNotMatch(err.message, /\n/);
      assert.ok(err.message.length <= 240);
      return true;
    },
  );
});

test("goal proposer timeout env is bounded", () => {
  assert.equal(resolveGoalProposerTimeoutMs(undefined), 120_000);
  assert.equal(resolveGoalProposerTimeoutMs("250"), 250);
  assert.equal(resolveGoalProposerTimeoutMs("999999999"), 600_000);
  assert.equal(resolveGoalProposerTimeoutMs("not-a-number"), 120_000);
});

function createFakeCodex(prefix, script) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, script, "utf8");
  chmodSync(fakeCodex, 0o755);
  return { cwd, bin };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
