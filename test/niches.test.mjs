import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readNiches, writeNiches } from "../dist/state/niches.js";

test("readNiches treats missing, corrupt, or malformed maps as empty", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-niches-read-"));

  assert.equal(readNiches(cwd), undefined);

  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  const path = join(cwd, ".darwin", "niches.json");
  writeFileSync(path, "{not json");
  assert.equal(readNiches(cwd), undefined);

  writeFileSync(path, JSON.stringify({}));
  assert.equal(readNiches(cwd), undefined);

  writeFileSync(
    path,
    JSON.stringify([{ attempt_id: "iter-1", score: 1, niche: "fast" }]),
  );
  assert.equal(readNiches(cwd), undefined);

  writeFileSync(path, JSON.stringify({
    fast: { attempt_id: "", score: 1, niche: "fast" },
  }));
  assert.equal(readNiches(cwd), undefined);

  writeFileSync(path, JSON.stringify({
    fast: { attempt_id: "iter-1", score: "1", niche: "fast" },
  }));
  assert.equal(readNiches(cwd), undefined);
});

test("writeNiches persists only valid non-empty maps", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-niches-write-"));
  const path = join(cwd, ".darwin", "niches.json");
  const record = {
    fast: {
      attempt_id: "iter-2",
      score: 0.7,
      niche: "latency=fast",
      run_dir: "runs/iter-2",
    },
  };

  writeNiches(undefined, cwd);
  assert.equal(existsSync(path), false);

  writeNiches({
    broken: { attempt_id: "iter-1", score: Number.NaN, niche: "bad" },
  }, cwd);
  assert.equal(existsSync(path), false);

  writeNiches(record, cwd);

  assert.deepEqual(readNiches(cwd), record);
  assert.match(readFileSync(path, "utf8"), /\n$/);
});
