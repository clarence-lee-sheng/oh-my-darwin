import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFrontier,
  writeFrontier,
} from "../dist/state/frontier.js";

test("readFrontier treats missing, corrupt, or malformed records as empty", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-frontier-read-"));

  assert.equal(readFrontier(cwd), null);

  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  const path = join(cwd, ".darwin", "frontier.json");
  writeFileSync(path, "{not json");
  assert.equal(readFrontier(cwd), null);

  writeFileSync(path, JSON.stringify({ attempt_id: "iter-1", t: "2026-05-19T00:00:00.000Z" }));
  assert.equal(readFrontier(cwd), null);

  writeFileSync(path, JSON.stringify({ attempt_id: "", score: 1, t: "2026-05-19T00:00:00.000Z" }));
  assert.equal(readFrontier(cwd), null);

  writeFileSync(path, JSON.stringify({ attempt_id: "iter-1", score: "1", t: "2026-05-19T00:00:00.000Z" }));
  assert.equal(readFrontier(cwd), null);
});

test("writeFrontier persists a readable frontier record", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-frontier-write-"));
  const record = {
    attempt_id: "iter-2",
    score: null,
    t: "2026-05-19T00:00:00.000Z",
    note: "kept",
    run_dir: "runs/iter-2",
  };

  writeFrontier(record, cwd);

  assert.deepEqual(readFrontier(cwd), record);
  assert.match(readFileSync(join(cwd, ".darwin", "frontier.json"), "utf8"), /\n$/);
});
