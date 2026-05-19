import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  callInterviewer,
  resolveInterviewerTimeoutMs,
} from "../dist/interview/codex-call.js";

test("callInterviewer keeps bounded stderr diagnostics on engine failure", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-interviewer-error-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
printf '%05000dINTERVIEWER_FAILURE_MARKER\\n' 0 >&2
exit 7
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    await assert.rejects(
      () => callInterviewer("system", [{ role: "user", content: "hello" }], "codex", ["--dangerously-bypass-approvals-and-sandbox"]),
      (error) => {
        assert.match(error.message, /codex exec exited with code 7/);
        assert.match(error.message, /INTERVIEWER_FAILURE_MARKER/);
        assert.ok(error.message.length < 4_300, error.message);
        return true;
      },
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("callInterviewer times out stuck engines", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-interviewer-timeout-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
trap 'exit 143' TERM
cat >/dev/null
sleep 10
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    await assert.rejects(
      () => callInterviewer(
        "system",
        [{ role: "user", content: "hello" }],
        "codex",
        ["--dangerously-bypass-approvals-and-sandbox"],
        { timeoutMsRaw: "50" },
      ),
      /codex exec exited with code 124/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("interviewer timeout env is bounded", () => {
  assert.equal(resolveInterviewerTimeoutMs(undefined), 120_000);
  assert.equal(resolveInterviewerTimeoutMs("250"), 250);
  assert.equal(resolveInterviewerTimeoutMs("999999999"), 600_000);
  assert.equal(resolveInterviewerTimeoutMs("not-a-number"), 120_000);
});
