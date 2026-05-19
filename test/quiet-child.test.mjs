import assert from "node:assert/strict";
import test from "node:test";

import { formatQuietChildStderrTail } from "../dist/runtime/quiet-child.js";

test("formatQuietChildStderrTail formats non-empty stderr tails", () => {
  assert.equal(
    formatQuietChildStderrTail("proposer", "bad news\n"),
    "darwin: proposer stderr tail (9 chars)\nbad news\n",
  );
});

test("formatQuietChildStderrTail omits blank tails", () => {
  assert.equal(formatQuietChildStderrTail("proposer", " \n\t"), "");
});
