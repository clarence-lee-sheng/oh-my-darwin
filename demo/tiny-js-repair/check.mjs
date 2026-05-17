import assert from "node:assert/strict";
import { slugify } from "./src/slugify.js";

assert.equal(slugify(" Hello, Darwin! "), "hello-darwin");
assert.equal(slugify("A/B Test: 50% Win"), "a-b-test-50-win");
assert.equal(slugify("already---slug"), "already-slug");
assert.equal(slugify("___Agent Harness___"), "agent-harness");

console.log("slugify checks passed");
