// Greedy strategy — darwin's default behavior, made explicit.
//
// Always mutates against the current frontier. Last 5 history rows are
// shown to the proposer as context. Frontier is replaced if score improves.
//
// Use when: you have a clear scorer and don't need exploration.
// Avoid when: the proposer keeps proposing minor variations and the score
//             has plateaued — switch to tournament or novelty.

export default {
  buildPrompt: (task) => task,

  selectParents(ctx) {
    return [
      {
        attempt_id: ctx.frontier.attempt_id,
        score: ctx.frontier.score,
        outcome: "scored",
      },
    ];
  },

  mutationDirective(_ctx) {
    return "Mutate against the frontier. Keep changes small and focused.";
  },
};
