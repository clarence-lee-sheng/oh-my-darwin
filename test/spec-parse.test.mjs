import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readSpec } from "../dist/spec/parse.js";

test("readSpec missing-file diagnostic uses a repo-relative path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-spec-missing-"));

  assert.throws(
    () => readSpec(cwd),
    (err) => {
      assert.match(err.message, /no spec found at \.darwin\/meta-spec\.md/);
      assert.doesNotMatch(err.message, new RegExp(escapeRegExp(cwd)));
      assert.doesNotMatch(err.message, /\n/);
      return true;
    },
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
