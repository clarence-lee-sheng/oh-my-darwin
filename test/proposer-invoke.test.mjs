import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  formatProposerOutputPathForTerminal,
  invokeProposer,
  resolveProposerRunner,
  resolveProposerTimeoutMs,
} from "../dist/proposer/invoke.js";

function fakeCodex(bin, script) {
  const codex = join(bin, "codex");
  writeFileSync(codex, script);
  chmodSync(codex, 0o755);
}

test("invokeProposer uses quiet exec mode and sends the prompt over stdin", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-invoke-"));
  const bin = join(cwd, "bin");
  const outputPath = join(cwd, "proposal.mjs");
  const argsPath = join(cwd, "args.json");
  const inputPath = join(cwd, "prompt.txt");
  writeFileSync(join(cwd, "placeholder"), "");
  mkdirSync(bin, { recursive: true });
  fakeCodex(bin, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(process.env.INPUT_PATH, input);
  writeFileSync(process.env.OUTPUT_PATH, "export default {};\\n");
  process.stdout.write("RAW_TRANSCRIPT_STDOUT\\n");
  process.stderr.write("RAW_TRANSCRIPT_STDERR\\n");
});
`);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.ARGS_PATH = argsPath;
  process.env.INPUT_PATH = inputPath;
  process.env.OUTPUT_PATH = outputPath;
  try {
    await invokeProposer("write a proposal", outputPath, "codex", [
      "--dangerously-bypass-approvals-and-sandbox",
    ], { runner: "exec" });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.ARGS_PATH;
    delete process.env.INPUT_PATH;
    delete process.env.OUTPUT_PATH;
  }

  const args = JSON.parse(readFileSync(argsPath, "utf-8"));
  assert.deepEqual(args, [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--disable",
    "hooks",
    "--color",
    "never",
    "-",
  ]);
  assert.equal(readFileSync(inputPath, "utf-8"), "write a proposal\n");
  assert.equal(existsSync(outputPath), true);
});

test("invokeProposer suppresses raw exec transcript output on success", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-invoke-quiet-"));
  const bin = join(cwd, "bin");
  const outputPath = join(cwd, "proposal.mjs");
  const helperPath = join(cwd, "helper.mjs");
  writeFileSync(join(cwd, "placeholder"), "");
  mkdirSync(bin, { recursive: true });
  fakeCodex(bin, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  writeFileSync(process.env.OUTPUT_PATH, "export default {};\\n");
  process.stdout.write("RAW_TRANSCRIPT_STDOUT\\n");
  process.stderr.write("RAW_TRANSCRIPT_STDERR\\n");
});
`);
  writeFileSync(helperPath, `
import { invokeProposer } from ${JSON.stringify(new URL("../dist/proposer/invoke.js", import.meta.url).href)};
await invokeProposer("prompt", process.env.OUTPUT_PATH, "codex", ["--dangerously-bypass-approvals-and-sandbox"], { runner: "exec" });
`);

  const proc = spawnSync(process.execPath, [helperPath], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
    },
    encoding: "utf-8",
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.doesNotMatch(proc.stdout, /RAW_TRANSCRIPT_STDOUT/);
  assert.doesNotMatch(proc.stderr, /RAW_TRANSCRIPT_STDERR/);
  assert.match(proc.stderr, /darwin: invoking codex exec/);
});

test("invokeProposer surfaces bounded stderr tail on failure", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-invoke-fail-"));
  const bin = join(cwd, "bin");
  const outputPath = join(cwd, "proposal.mjs");
  const helperPath = join(cwd, "helper.mjs");
  mkdirSync(bin, { recursive: true });
  fakeCodex(bin, `#!/usr/bin/env node
process.stderr.write("HEAD_MARKER" + "x".repeat(6000) + "TAIL_MARKER\\n");
process.exit(9);
`);
  writeFileSync(helperPath, `
import { invokeProposer } from ${JSON.stringify(new URL("../dist/proposer/invoke.js", import.meta.url).href)};
try {
  await invokeProposer("prompt", process.env.OUTPUT_PATH, "codex", ["--dangerously-bypass-approvals-and-sandbox"], { runner: "exec" });
} catch (err) {
  process.stderr.write(String(err) + "\\n");
  process.exit(42);
}
`);

  const proc = spawnSync(process.execPath, [helperPath], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
    },
    encoding: "utf-8",
  });

  assert.equal(proc.status, 42, proc.stderr);
  assert.match(proc.stderr, /darwin: proposer stderr tail/);
  assert.match(proc.stderr, /TAIL_MARKER/);
  assert.doesNotMatch(proc.stderr, /HEAD_MARKER/);
  assert.match(proc.stderr, /codex exited with code 9/);
});

test("invokeProposer times out stuck proposer engines", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-invoke-timeout-"));
  const bin = join(cwd, "bin");
  const outputPath = join(cwd, "proposal.mjs");
  const helperPath = join(cwd, "helper.mjs");
  mkdirSync(bin, { recursive: true });
  fakeCodex(bin, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  writeFileSync(helperPath, `
import { invokeProposer } from ${JSON.stringify(new URL("../dist/proposer/invoke.js", import.meta.url).href)};
try {
  await invokeProposer("prompt", process.env.OUTPUT_PATH, "codex", ["--dangerously-bypass-approvals-and-sandbox"], { runner: "exec" });
} catch (err) {
  process.stderr.write(String(err) + "\\n");
  process.exit(42);
}
`);

  const proc = spawnSync(process.execPath, [helperPath], {
    cwd,
    env: {
      ...process.env,
      DARWIN_PROPOSER_TIMEOUT_MS: "50",
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
    },
    encoding: "utf-8",
    timeout: 5_000,
  });

  assert.equal(proc.status, 42, proc.stderr);
  assert.match(proc.stderr, /darwin: proposer timed out after <1s - terminating codex exec/);
  assert.match(proc.stderr, /codex proposer timed out/);
  assert.doesNotMatch(proc.stderr, /[^\x00-\x7F]/);
});

test("proposer output paths are relative, single-line, and bounded for terminal output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-path-"));
  const outputPath = join(
    cwd,
    ".darwin",
    "proposals",
    `iter-1\n${"x".repeat(500)}`,
    "harness.mjs",
  );

  const formatted = formatProposerOutputPathForTerminal(outputPath, cwd);

  assert.match(formatted, /^\.darwin\/proposals\/iter-1 x+/);
  assert.doesNotMatch(formatted, new RegExp(escapeRegExp(cwd)));
  assert.doesNotMatch(formatted, /\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 160);
});

test("proposer output paths outside cwd hide absolute temp roots", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-project-"));
  const outputPath = join(
    tmpdir(),
    `darwin-proposer-external\n${"x".repeat(500)}`,
    "harness.mjs",
  );

  const formatted = formatProposerOutputPathForTerminal(outputPath, cwd);

  assert.match(formatted, /^<external>\/darwin-proposer-external x+\.\.\.\/harness\.mjs$/);
  assert.doesNotMatch(formatted, new RegExp(escapeRegExp(tmpdir())));
  assert.doesNotMatch(formatted, /^\//);
  assert.doesNotMatch(formatted, /\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 160);
});

test("resolveProposerRunner defaults to interactive unless env or flag overrides", () => {
  assert.equal(resolveProposerRunner(undefined, undefined), "interactive");
  assert.equal(resolveProposerRunner(undefined, "exec"), "exec");
  assert.equal(resolveProposerRunner("interactive", "exec"), "interactive");
});

test("resolveProposerRunner keeps invalid env diagnostics single-line and bounded", () => {
  assert.throws(
    () => resolveProposerRunner(undefined, `dirty\n${"r".repeat(1000)}`),
    (err) => {
      assert.match(err.message, /invalid proposer runner "dirty r+/);
      assert.doesNotMatch(err.message, /dirty\n/);
      assert.doesNotMatch(err.message, /r{300}/);
      assert.ok(err.message.length <= 220);
      return true;
    },
  );
});

test("proposer timeout env is bounded", () => {
  assert.equal(resolveProposerTimeoutMs(undefined), 120_000);
  assert.equal(resolveProposerTimeoutMs("250"), 250);
  assert.equal(resolveProposerTimeoutMs("999999999"), 600_000);
  assert.equal(resolveProposerTimeoutMs("not-a-number"), 120_000);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
