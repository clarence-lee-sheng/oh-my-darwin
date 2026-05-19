import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  countEvolutionRows,
  readEvolutionSummary,
  readLastEvolutionHint,
  readRecentEvolution,
} from "../dist/state/history.js";

function writeEvolution(cwd, lines) {
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "evolution.jsonl"), lines.join("\n"));
}

function row(attempt_id, extra = {}) {
  return JSON.stringify({
    t: "2026-05-19T00:00:00.000Z",
    attempt_id,
    score: null,
    outcome: "skipped",
    ...extra,
  });
}

test("readRecentEvolution returns the newest requested rows without parsing older lines", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-recent-"));
  writeEvolution(cwd, [
    row("iter-1"),
    "not json",
    row("iter-2"),
    row("iter-3"),
    "",
    row("iter-4"),
  ]);

  const rows = readRecentEvolution(cwd, 3);

  assert.deepEqual(rows.map((r) => r.attempt_id), ["iter-2", "iter-3", "iter-4"]);
});

test("evolution readers treat missing logs as empty", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-missing-"));

  assert.deepEqual(readRecentEvolution(cwd, 5), []);
  assert.deepEqual(readEvolutionSummary(cwd, 5), { rowCount: 0, recent: [] });
  assert.equal(countEvolutionRows(cwd), 0);
  assert.equal(readLastEvolutionHint(cwd), undefined);
});

test("readRecentEvolution skips malformed tail lines while finding recent rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-malformed-tail-"));
  writeEvolution(cwd, [
    row("iter-1"),
    row("iter-2"),
    row("iter-3"),
    "not json",
    "{",
  ]);

  const rows = readRecentEvolution(cwd, 2);

  assert.deepEqual(rows.map((r) => r.attempt_id), ["iter-2", "iter-3"]);
});

test("evolution readers skip wrong-shaped JSON rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-shape-"));
  writeEvolution(cwd, [
    row("iter-1", { goal: "keep", knobs: { model: "default" } }),
    JSON.stringify({ t: "2026-05-19T00:00:00.000Z", attempt_id: "", score: 1, outcome: "scored" }),
    JSON.stringify({ t: "2026-05-19T00:00:00.000Z", attempt_id: "bad-score", score: "1", outcome: "scored" }),
    JSON.stringify({ t: "2026-05-19T00:00:00.000Z", attempt_id: "bad-outcome", score: 1, outcome: 42 }),
    row("iter-2", {
      delta: "bad",
      duration_s: Number.NaN,
      exit_reason: 42,
      knobs: { approval: "default" },
    }),
  ]);

  const rows = readRecentEvolution(cwd, 5);

  assert.deepEqual(rows.map((r) => r.attempt_id), ["iter-1", "iter-2"]);
  assert.deepEqual(rows[0].knobs, { model: "default" });
  assert.deepEqual(rows[1], {
    t: "2026-05-19T00:00:00.000Z",
    attempt_id: "iter-2",
    score: null,
    outcome: "skipped",
    knobs: { approval: "default" },
  });
});

test("readEvolutionSummary counts rows while backfilling valid recent attempts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-summary-"));
  writeEvolution(cwd, [
    row("iter-1"),
    "",
    row("iter-2"),
    row("iter-3"),
    "not json",
    "{",
  ]);

  const summary = readEvolutionSummary(cwd, 2);

  assert.equal(summary.rowCount, 5);
  assert.deepEqual(summary.recent.map((r) => r.attempt_id), ["iter-2", "iter-3"]);
});

test("readLastEvolutionHint scans backward to the newest non-empty hint", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-hint-"));
  const filler = Array.from({ length: 1200 }, (_, i) => row(`filler-${i}`));
  writeEvolution(cwd, [
    row("older", { next_hint: "older hint" }),
    ...filler,
    row("newer-empty", { next_hint: "   " }),
    JSON.stringify({ next_hint: "malformed hint" }),
    row("newer", { next_hint: "new hint" }),
    row("tail"),
  ]);

  assert.equal(readLastEvolutionHint(cwd), "new hint");
});

test("countEvolutionRows counts non-empty JSONL rows without requiring a trailing newline", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-history-count-"));
  writeEvolution(cwd, [
    row("iter-1"),
    "",
    row("iter-2"),
    "   ",
    row("iter-3"),
  ]);

  assert.equal(countEvolutionRows(cwd), 4);
});
