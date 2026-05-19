import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEngine } from "../dist/runtime/run-loop.js";

test("runEngine records run_end when engine launch fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-run-loop-"));
  const emptyPath = join(cwd, "empty-bin");
  mkdirSync(emptyPath);
  const oldCwd = process.cwd();
  const oldPath = process.env.PATH;
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    process.chdir(cwd);
    process.env.PATH = emptyPath;
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    const code = await runEngine(["large prompt"], "codex", []);

    assert.equal(code, 1);
    assert.match(stderr, /darwin: codex launch failed/);
    const events = readFileSync(join(cwd, ".darwin", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "run_start");
    assert.equal(events[1].event, "run_end");
    assert.equal(events[1].exit_code, 1);
    assert.match(events[1].error, /spawn codex ENOENT/);
  } finally {
    process.chdir(oldCwd);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});
