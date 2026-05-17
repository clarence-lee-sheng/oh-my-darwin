// Baseline darwin harness for the tiny-js-repair hackathon demo.
export default {
  buildPrompt(task) {
    return `${task}\n\nWork deterministically: inspect check.mjs and score.mjs, edit only src/slugify.js, then run npm test. Do not edit the scorer or tests.`;
  },
  suggestNextHypothesis() {
    return "For tiny deterministic repos, make the executor inspect the scorer first, edit the smallest implementation file, and verify with the declared command.";
  },
};
