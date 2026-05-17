import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invokeGoalProposer } from "../dist/proposer/goal-proposer.js";

test("goal proposer falls back from missing OMX to Codex and parses final JSON", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-goal-proposer-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
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
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    const candidate = await invokeGoalProposer("propose", cwd, {
      engine: "omx",
      engineArgs: ["--madmax", "--xhigh"],
    });
    assert.equal(candidate.goal, "reply READY");
    assert.deepEqual(candidate.knobs, {});
    assert.equal(candidate.rationale, "fallback smoke");
  } finally {
    process.env.PATH = oldPath;
  }
});
