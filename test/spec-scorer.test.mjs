import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractScorer } from "../dist/spec/parse.js";
import { scoreRun } from "../dist/scorer/index.js";

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
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
