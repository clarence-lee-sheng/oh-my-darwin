import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildExecGoalPrompt,
  resolveGoalAttemptMode,
} from "../dist/runtime/goal-attempt.js";
import { engineExecArgs, engineInteractiveArgs } from "../dist/runtime/engine.js";
import {
  formatCapabilityPromotionNote,
  formatGoalCandidateForTerminal,
  formatFrontierForPrompt,
  formatHarnessForPrompt,
  formatMetaLoopHeader,
  formatParentsForPrompt,
  formatShortAdvisoryText,
  formatSpecCapabilitiesForPrompt,
  formatTaskForProposerPrompt,
  normalizeNextHypothesisHint,
  parseLoopOptions,
  resolveLoopGoalRunner,
  shouldPromptForGoalApproval,
} from "../dist/cli/meta.js";

test("goal attempt defaults to initial /goal prompt mode", () => {
  assert.equal(resolveGoalAttemptMode(undefined, undefined), "initial");
});

test("goal attempt preserves slash mode as explicit legacy override", () => {
  assert.equal(resolveGoalAttemptMode(undefined, "tui"), "slash");
  assert.equal(resolveGoalAttemptMode("initial", "tui"), "initial");
  assert.equal(resolveGoalAttemptMode("exec", "tui"), "exec");
  assert.equal(resolveGoalAttemptMode("slash", "initial"), "slash");
});

test("goal attempt mode env accepts initial prompt aliases", () => {
  assert.equal(resolveGoalAttemptMode(undefined, "/goal"), "initial");
  assert.equal(resolveGoalAttemptMode(undefined, "prompt"), "initial");
});

test("meta goal runner option preserves env fallback unless flag is explicit", () => {
  assert.equal(parseLoopOptions(["--goal-mode"]).goalRunner, undefined);
  assert.equal(resolveGoalAttemptMode(parseLoopOptions(["--goal-mode"]).goalRunner, "slash"), "slash");
  assert.equal(parseLoopOptions(["--goal-mode", "--goal-runner", "initial"]).goalRunner, "initial");
  assert.equal(resolveGoalAttemptMode(parseLoopOptions(["--goal-mode", "--goal-runner", "initial"]).goalRunner, "slash"), "initial");
  assert.equal(parseLoopOptions(["--goal-mode", "--goal-runner", "prompt"]).goalRunner, "initial");
  assert.equal(parseLoopOptions(["--goal-mode", "--goal-runner", "exec"]).goalRunner, "exec");
  assert.equal(resolveGoalAttemptMode(parseLoopOptions(["--goal-mode", "--goal-runner", "exec"]).goalRunner, "slash"), "exec");
});

test("meta defaults to goal-mode and keeps harness-mode as explicit override", () => {
  assert.equal(parseLoopOptions([]).goalMode, true);
  assert.equal(parseLoopOptions(["--goal-mode"]).goalMode, true);
  assert.equal(parseLoopOptions(["--harness-mode"]).goalMode, false);
  assert.equal(parseLoopOptions(["--no-goal-mode"]).goalMode, false);
  assert.throws(
    () => parseLoopOptions(["--goal-mode", "--harness-mode"]),
    /choose either --goal-mode or --harness-mode/,
  );
});

test("goal-mode still evolves and promotes harness.mjs around /goal attempts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-mode-harness-"));
  const bin = join(cwd, "bin");
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(cwd, ".darwin", "meta-spec.md"),
    `# oh-my-darwin meta-spec - harness-central

## Task
Improve the demo outcome.

## Scorer
- source: command
- direction: higher
- command: ${process.execPath} score.js
- parse: first_number
`,
  );
  writeFileSync(
    join(cwd, ".darwin", "frontier.json"),
    JSON.stringify({ attempt_id: "baseline", score: 0, t: new Date().toISOString() }, null, 2) + "\n",
  );
  writeFileSync(join(cwd, "score.js"), "console.log(10);\n");

  const goalAttemptPromptPath = join(cwd, "goal-attempt-prompt.txt");
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const lastIdx = args.indexOf("--output-last-message");
const lastPath = lastIdx === -1 ? "" : args[lastIdx + 1];
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (input.includes("Your job: write ONE new harness file")) {
    const marker = input.match(/Then write exactly ONE file at: ([^\\n]+)/);
    if (!marker) process.exit(31);
    const out = path.resolve(process.cwd(), marker[1].trim());
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, [
      "// candidate harness marker",
      "export default {",
      "  buildPrompt: (task) => 'HARNESS GOAL CONTEXT: ' + task,",
      "  suggestNextHypothesis: () => 'try the harness context next'",
      "};",
      ""
    ].join("\\n"));
    process.exit(0);
  }
  if (input.includes("OUTPUT FORMAT (STRICT)")) {
    if (!input.includes("HARNESS GOAL CONTEXT")) process.exit(32);
    fs.writeFileSync(lastPath, JSON.stringify({
      goal: "complete using the harness-shaped task context",
      knobs: {},
      rationale: "proves goal-mode used the candidate harness before proposing"
    }));
    process.exit(0);
  }
  if (input.includes("darwin goal-mode")) {
    fs.writeFileSync(${JSON.stringify(goalAttemptPromptPath)}, input);
    if (lastPath) fs.writeFileSync(lastPath, "done");
    process.exit(0);
  }
  process.exit(33);
});
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const cli = new URL("../dist/cli/index.js", import.meta.url).pathname;
  const proc = spawnSync(
    process.execPath,
    [
      cli,
      "--codex",
      "meta",
      "--iterations",
      "1",
      "--proposer-runner",
      "exec",
      "--goal-runner",
      "exec",
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    },
  );

  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(existsSync(join(cwd, ".darwin", "proposals", "iter-1", "harness.mjs")), true);
  assert.match(
    readFileSync(join(cwd, ".darwin", "runs", "iter-1", "harness.mjs"), "utf8"),
    /candidate harness marker/,
  );
  assert.match(
    readFileSync(join(cwd, ".darwin", "harness", "harness.mjs"), "utf8"),
    /candidate harness marker/,
  );
  assert.match(readFileSync(goalAttemptPromptPath, "utf8"), /HARNESS GOAL CONTEXT/);
});

test("meta defers engine launch modules until an iteration launches", () => {
  const source = readFileSync(new URL("../dist/cli/meta.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /^import .*"\.\.\/runtime\/bridge\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/runtime\/goal-attempt\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/scorer\/index\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/strategy\/context\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/strategy\/contract\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/strategy\/defaults\.js";$/m);
  assert.doesNotMatch(source, /^import .*"\.\.\/state\/niches\.js";$/m);
  assert.match(source, /await import\("\.\.\/runtime\/bridge\.js"\)/);
  assert.match(source, /await import\("\.\.\/runtime\/goal-attempt\.js"\)/);
  assert.match(source, /await import\("\.\.\/scorer\/index\.js"\)/);
  assert.match(source, /import\("\.\.\/strategy\/context\.js"\)/);
  assert.match(source, /import\("\.\.\/strategy\/contract\.js"\)/);
  assert.match(source, /import\("\.\.\/strategy\/defaults\.js"\)/);
  assert.match(source, /await import\("\.\.\/state\/niches\.js"\)/);
});

test("meta proposer runner option supports interactive harness proposer", () => {
  assert.equal(parseLoopOptions(["--proposer-runner", "interactive"]).proposerRunner, "interactive");
  assert.equal(parseLoopOptions(["--interactive-proposer"]).proposerRunner, "interactive");
  assert.equal(parseLoopOptions(["--interactive-propose"]).proposerRunner, "interactive");
  assert.equal(parseLoopOptions(["--proposer-runner", "exec"]).proposerRunner, "exec");
  assert.throws(
    () => parseLoopOptions(["--proposer-runner", "wat"]),
    /invalid --proposer-runner value/,
  );
});

test("meta option diagnostics keep invalid values single-line and bounded", () => {
  const dirty = `dirty\n${"v".repeat(1000)}`;

  for (const args of [
    ["--duration", dirty],
    ["--attempt-max", dirty],
    ["--attempt-quiet", dirty],
    ["--goal-runner", dirty],
    ["--proposer-runner", dirty],
  ]) {
    assert.throws(
      () => parseLoopOptions(args),
      (err) => {
        assert.match(err.message, /dirty v+/);
        assert.doesNotMatch(err.message, /dirty\n/);
        assert.doesNotMatch(err.message, /v{300}/);
        assert.ok(err.message.length <= 240, err.message);
        return true;
      },
    );
  }
});

test("meta goal runner defaults to initial /goal prompt unless env or flag is explicit", () => {
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: undefined, interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }, undefined),
    "initial",
  );
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: undefined, interactive: true, maxIterations: 1, maxDurationMs: Infinity }, undefined),
    "initial",
  );
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: undefined, interactive: false, maxIterations: 1, maxDurationMs: Infinity }, undefined),
    "initial",
  );
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: "exec", interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }, "slash"),
    "exec",
  );
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: "slash", interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }, undefined),
    "slash",
  );
  assert.equal(
    resolveLoopGoalRunner({ goalRunner: undefined, interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }, "exec"),
    undefined,
  );
});

test("exec prompt carries multiline goals without slash injection", () => {
  const prompt = buildExecGoalPrompt("line one\nline two");
  assert.match(prompt, /darwin goal-mode/);
  assert.match(prompt, /line one\nline two/);
  assert.doesNotMatch(prompt, /^\/goal/m);
});

test("OMX exec args translate launch-only flags for codex-compatible exec", () => {
  assert.deepEqual(
    engineExecArgs("omx", ["--madmax", "--xhigh", "--direct", "--worktree", "tmp"], ["-"]),
    ["exec", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model_reasoning_effort="xhigh"', "-"],
  );
});

test("OMX interactive args retain direct launch but strip conflicting launch policy", () => {
  assert.deepEqual(
    engineInteractiveArgs("omx", ["--madmax", "--xhigh", "--tmux"], ["--no-alt-screen"]),
    ["--direct", "--madmax", "--xhigh", "--no-alt-screen"],
  );
});

test("goal approval prompt stays on for unbounded/manual runs only", () => {
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }),
    true,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: true, maxIterations: 1, maxDurationMs: Infinity }),
    true,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: 1, maxDurationMs: Infinity }),
    false,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: Infinity, maxDurationMs: 60_000 }),
    false,
  );
});

test("goal candidate terminal preview is bounded and indented", () => {
  const preview = formatGoalCandidateForTerminal(
    {
      goal: `line one\n${"x".repeat(1500)}`,
      rationale: `why\n${"y".repeat(1000)}`,
      knobs: {
        sandbox: "workspace-write",
        long: "z".repeat(1000),
      },
    },
    "runs/iter-1/candidate.json",
  );

  assert.match(preview, /^\ndarwin: proposed goal:\n  line one\n  x+/);
  assert.match(preview, /  rationale:\n    why\n    y+/);
  assert.match(preview, /\.darwin\/runs\/iter-1\/candidate\.json/);
  assert.match(preview, /  knobs: sandbox=workspace-write, long=z+/);
  assert.doesNotMatch(preview, /x{1200}/);
  assert.doesNotMatch(preview, /y{800}/);
  assert.doesNotMatch(preview, /z{600}/);

  for (const line of preview.split("\n").filter(Boolean)) {
    if (line.startsWith("darwin:")) continue;
    assert.match(line, /^  /);
  }
});

test("parent prompt summaries are single-line bounded fields", () => {
  const prompt = formatParentsForPrompt([
    {
      attempt_id: `iter-7\n${"a".repeat(1000)}`,
      score: 10,
      outcome: `scored\n${"o".repeat(1000)}`,
      goal: `line one\n${"x".repeat(1000)}`,
      rationale: `why\n${"y".repeat(1000)}`,
    },
  ]);

  assert.match(prompt, /^- iter-7 a+\.{3} \(score=10, scored o+\.{3}\)\n    goal: line one x+/);
  assert.match(prompt, /\n    why: why y+/);
  assert.doesNotMatch(prompt, /iter-7\na/);
  assert.doesNotMatch(prompt, /scored\no/);
  assert.doesNotMatch(prompt, /line one\nx/);
  assert.doesNotMatch(prompt, /why\ny/);
  assert.doesNotMatch(prompt, /a{300}/);
  assert.doesNotMatch(prompt, /o{300}/);
  assert.doesNotMatch(prompt, /x{300}/);
  assert.doesNotMatch(prompt, /y{300}/);
});

test("frontier prompt summary is single-line and bounded", () => {
  const prompt = formatFrontierForPrompt(`frontier\n${"f".repeat(1000)}`, null);

  assert.match(prompt, /^- attempt_id: frontier f+\.{3}\n- score: null$/);
  assert.doesNotMatch(prompt, /frontier\nf/);
  assert.doesNotMatch(prompt, /f{300}/);
});

test("current harness prompt block is bounded with artifact pointer", () => {
  const prompt = formatHarnessForPrompt(`export default {}\n${"x".repeat(25_000)}`);

  assert.match(prompt, /^export default \{\}/);
  assert.match(prompt, /\/\/ \.\.\.\[truncated; full harness saved to \.darwin\/harness\/harness\.mjs\]$/);
  assert.ok(prompt.length < 21_000);
  assert.doesNotMatch(prompt, /x{21_000}/);
});

test("harness-mode task prompt block is bounded with artifact pointer", () => {
  const prompt = formatTaskForProposerPrompt(`task line\n${"x".repeat(25_000)}`);

  assert.match(prompt, /^task line/);
  assert.match(prompt, /\.\.\.\[truncated; full task saved to \.darwin\/meta-spec\.md\]$/);
  assert.ok(prompt.length < 21_000);
  assert.doesNotMatch(prompt, /x{21_000}/);
});

test("harness-mode spec capability policy is bounded with artifact pointer", () => {
  const prompt = formatSpecCapabilitiesForPrompt(`- custom rule\n${"x".repeat(12_000)}`);

  assert.match(prompt, /^- custom rule\nx+/);
  assert.match(prompt, /\.\.\.\[truncated; full capability policy saved to \.darwin\/meta-spec\.md\]$/);
  assert.ok(prompt.length < 8_500);
  assert.doesNotMatch(prompt, /x{9_000}/);
});

test("harness-mode spec capability policy has a stable default", () => {
  const prompt = formatSpecCapabilitiesForPrompt("");

  assert.match(prompt, /repo-scoped Codex Agent Skills/);
  assert.match(prompt, /native \.codex\/hooks\.json/);
});

test("capability promotion note is single-line bounded text", () => {
  const note = formatCapabilityPromotionNote([
    `.agents/skills/noisy\n${"a".repeat(1000)}/SKILL.md`,
    `.codex/hooks.json#Stop\n${"b".repeat(1000)}`,
    "cap-3",
    "cap-4",
    "cap-5",
    "cap-6",
    "cap-7",
    "cap-8",
    "cap-9",
    "cap-10",
  ]);

  assert.match(note ?? "", /^capabilities promoted for next iteration: \.agents\/skills\/noisy a+/);
  assert.match(note ?? "", /\.\.\. 2 more$/);
  assert.doesNotMatch(note ?? "", /noisy\n/);
  assert.doesNotMatch(note ?? "", /Stop\n/);
  assert.doesNotMatch(note ?? "", /a{300}/);
  assert.doesNotMatch(note ?? "", /b{300}/);
  assert.ok((note ?? "").length <= 1_100);
  assert.equal(formatCapabilityPromotionNote([]), undefined);
});

test("next hypothesis hints are optional single-line bounded strings", () => {
  assert.equal(normalizeNextHypothesisHint(undefined), undefined);
  assert.equal(normalizeNextHypothesisHint("   "), undefined);

  const hint = normalizeNextHypothesisHint(`try this\n${"x".repeat(2_000)}`);
  assert.match(hint, /^try this x+/);
  assert.doesNotMatch(hint ?? "", /try this\n/);
  assert.doesNotMatch(hint ?? "", /x{1200}/);
  assert.ok((hint ?? "").length <= 1_000);
});

test("short advisory prompt text is single-line and bounded", () => {
  const text = formatShortAdvisoryText(`directive\n${"x".repeat(2_000)}`);

  assert.match(text, /^directive x+/);
  assert.doesNotMatch(text, /directive\n/);
  assert.doesNotMatch(text, /x{1200}/);
  assert.ok(text.length <= 1_000);
});

test("meta loop header is ASCII, single-line, and bounded", () => {
  const header = formatMetaLoopHeader(
    `noisy slug\n${"s".repeat(1000)}`,
    { goalMode: true },
    "exec",
    "bounded",
  );

  assert.match(header, /^darwin: meta loop for "noisy slug s+/);
  assert.match(header, /" - bounded - goal-mode - proposer=exec$/);
  assert.doesNotMatch(header, /noisy slug\ns/);
  assert.doesNotMatch(header, /s{300}/);
  assert.doesNotMatch(header, /[^\x00-\x7F]/);
});
