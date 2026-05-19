import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../dist/interview/prompt.js";

test("interviewer system prompt stays ASCII-only", () => {
  const prompt = buildSystemPrompt("README.md\nsrc/index.ts");

  assert.match(prompt, /# oh-my-darwin meta-spec - <slug>/);
  assert.match(prompt, /When mean ambiguity is <= 0\.2/);
  assert.doesNotMatch(prompt, /[^\x00-\x7F]/);
});
