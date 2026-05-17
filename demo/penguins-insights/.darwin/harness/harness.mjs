// Baseline darwin harness for the penguins-insights non-code analytics demo.
export default {
  buildPrompt(task) {
    return `${task}\n\nWork deterministically: inspect data/penguins.csv and score.mjs, create only insights.json, then run npm test. Do not edit the dataset, scorer, package.json, or .darwin files.`;
  },
  suggestNextHypothesis() {
    return "For dataset/reporting tasks, make the executor compute exact facts from source data, emit a schema-checked artifact, and verify with the declared scorer.";
  },
};
