// Baseline darwin harness. Replace this with a proposer-authored version
// during `darwin meta` iterations.
//
// Required: default-export an object with a `buildPrompt(task)` method that
// returns a non-empty string.
//
// Optional: implement `suggestNextHypothesis()` returning a short string
// the next iteration's proposer will see as a hint.

/** @typedef {{ buildPrompt: (task: string) => string, suggestNextHypothesis?: () => string }} Harness */

/** @type {Harness} */
export default {
  buildPrompt: (task) => task,
  // suggestNextHypothesis: () => "",  // uncomment + return advice to steer the next iteration
};
