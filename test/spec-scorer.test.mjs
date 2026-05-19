import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractScorer } from "../dist/spec/parse.js";
import { scoreRun } from "../dist/scorer/index.js";
import {
  resolveScorerParseBufferLimit,
  resolveScorerTimeoutMs,
} from "../dist/scorer/command.js";

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function captureStderr() {
  const originalWrite = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk));
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

function withRunDir(fn) {
  const root = mkdtempSync(join(tmpdir(), "darwin-scorer-"));
  const runDir = join(root, ".darwin", "runs", "baseline");
  mkdirSync(runDir, { recursive: true });
  return Promise.resolve()
    .then(() => fn(runDir))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("extractScorer accepts verification mode aliases", () => {
  const scorer = extractScorer(`# oh-my-darwin meta-spec - demo

## Scorer
- verification mode: test suite
- metric direction: lower
- test command: npm test
- parse rule: exit_code
`);

  assert.equal(scorer.source, "test-suite");
  assert.equal(scorer.direction, "lower_is_better");
  assert.equal(scorer.command, "npm test");
  assert.equal(scorer.parse, "exit_code");
});

test("extractScorer infers command scorer when a command is configured", () => {
  const scorer = extractScorer(`## Scorer
- name: quality score
- command: node score.js
- parse: last_number
`);

  assert.equal(scorer.source, "command");
  assert.equal(scorer.command, "node score.js");
  assert.equal(scorer.parse, "last_number");
});

test("command scorer parses numeric command output without prompting", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "command",
        direction: "higher_is_better",
        command: nodeCommand("console.log('score: 41'); console.log('score: 42');"),
        parse: "last_number",
      },
      runDir,
    );

    assert.equal(result.score, 42);
    assert.match(result.note ?? "", /command scorer parsed score 42/);
  });
});

test("command scorer times out stuck commands and records exit artifact", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "command",
        direction: "higher_is_better",
        command: nodeCommand("setInterval(() => {}, 1000);"),
      },
      runDir,
      { timeoutMsRaw: "50" },
    );

    assert.equal(result.score, null);
    assert.match(result.note ?? "", /timeout/);
    const exit = JSON.parse(readFileSync(join(runDir, "command.exit.json"), "utf-8"));
    assert.equal(exit.code, 124);
    assert.equal(exit.timedOut, true);
  });
});

test("command scorer streams full artifacts while parsing bounded output buffers", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "command",
        direction: "higher_is_better",
        command: nodeCommand('process.stdout.write("HEAD_MARKER\\n"); process.stdout.write("x".repeat(5000)); process.stdout.write("\\nscore: 77\\n");'),
        parse: "last_number",
      },
      runDir,
      { parseBufferCharsRaw: "100" },
    );

    assert.equal(result.score, 77);
    const stdout = readFileSync(join(runDir, "command.stdout.txt"), "utf-8");
    assert.match(stdout, /HEAD_MARKER/);
    assert.match(stdout, /score: 77/);
    const exit = JSON.parse(readFileSync(join(runDir, "command.exit.json"), "utf-8"));
    assert.equal(exit.stdoutParseBufferTruncated, true);
  });
});

test("command scorer explains parse failures caused by truncated parse buffers", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "command",
        direction: "higher_is_better",
        command: nodeCommand('process.stdout.write("x".repeat(5000)); process.stdout.write("\\nscore: 77\\n");'),
        parse: "first_number",
      },
      runDir,
      { parseBufferCharsRaw: "100" },
    );

    assert.equal(result.score, null);
    assert.match(result.note ?? "", /stdout parse buffer truncated/);
    assert.match(result.note ?? "", /full output is in scorer artifacts/);
    const stdout = readFileSync(join(runDir, "command.stdout.txt"), "utf-8");
    assert.match(stdout, /score: 77/);
  });
});

test("test-suite scorer explains parse failures caused by truncated parse buffers", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "test-suite",
        direction: "higher_is_better",
        command: nodeCommand('process.stdout.write("x".repeat(5000)); process.stdout.write("\\nscore: 77\\n");'),
        parse: "first_number",
      },
      runDir,
      { parseBufferCharsRaw: "100" },
    );

    assert.equal(result.score, null);
    assert.match(result.note ?? "", /stdout parse buffer truncated/);
    assert.match(result.note ?? "", /adjust parse rule/);
    const stdout = readFileSync(join(runDir, "test-suite.stdout.txt"), "utf-8");
    assert.match(stdout, /score: 77/);
  });
});

test("test-suite scorer uses pass/fail score by default", async () => {
  await withRunDir(async (runDir) => {
    const passing = await scoreRun(
      {
        source: "test-suite",
        direction: "higher_is_better",
        command: nodeCommand("process.exit(0);"),
      },
      runDir,
    );
    assert.equal(passing.score, 1);

    const failing = await scoreRun(
      {
        source: "test-suite",
        direction: "higher_is_better",
        command: nodeCommand("process.exit(7);"),
      },
      runDir,
    );
    assert.equal(failing.score, 0);
  });
});

test("scorer parse buffer env is bounded", () => {
  assert.equal(resolveScorerParseBufferLimit(undefined), 1_000_000);
  assert.equal(resolveScorerParseBufferLimit("250"), 250);
  assert.equal(resolveScorerParseBufferLimit("999999999"), 5_000_000);
  assert.equal(resolveScorerParseBufferLimit("not-a-number"), 1_000_000);
});

test("scorer timeout env is bounded", () => {
  assert.equal(resolveScorerTimeoutMs(undefined), 1_800_000);
  assert.equal(resolveScorerTimeoutMs("250"), 250);
  assert.equal(resolveScorerTimeoutMs("999999999"), 7_200_000);
  assert.equal(resolveScorerTimeoutMs("not-a-number"), 1_800_000);
});

test("llm-judge does not fall back to human verification", async () => {
  await withRunDir(async (runDir) => {
    const result = await scoreRun(
      {
        source: "llm-judge",
        direction: "higher_is_better",
      },
      runDir,
    );

    assert.equal(result.score, null);
    assert.match(result.note ?? "", /not implemented/);
  });
});

test("unknown scorer source diagnostics are single-line and bounded", async () => {
  await withRunDir(async (runDir) => {
    const capture = captureStderr();
    try {
      const result = await scoreRun(
        {
          source: `unknown\n${"x".repeat(1000)}`,
          direction: "higher_is_better",
        },
        runDir,
      );

      assert.equal(result.score, null);
      assert.match(result.note ?? "", /^unknown scorer source: unknown x+/);
      assert.ok((result.note ?? "").length <= 160);
      assert.doesNotMatch(result.note ?? "", /\n/);
      assert.doesNotMatch(result.note ?? "", /x{300}/);

      const stderr = capture.text();
      assert.match(stderr, /unknown scorer source 'unknown x+/);
      assert.doesNotMatch(stderr, /unknown\n/);
      assert.doesNotMatch(stderr, /x{300}/);
    } finally {
      capture.restore();
    }
  });
});

test("thrown scorer diagnostics are single-line and bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-scorer-"));
  const runDir = join(root, "run-dir-as-file");
  writeFileSync(runDir, "");
  const capture = captureStderr();

  try {
    const result = await scoreRun(
      {
        source: "command",
        direction: "higher_is_better",
        command: nodeCommand("process.stdout.write('score: 1\\n');"),
        parse: "last_number",
      },
      runDir,
    );

    assert.equal(result.score, null);
    assert.match(result.note ?? "", /^scorer 'command' failed: /);
    assert.ok((result.note ?? "").length <= 240);
    assert.doesNotMatch(result.note ?? "", /\n/);

    const stderr = capture.text();
    assert.match(stderr, /recording a skipped score/);
    assert.doesNotMatch(stderr, /\n.*\n/);
    assert.ok(stderr.length <= 340);
  } finally {
    capture.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
