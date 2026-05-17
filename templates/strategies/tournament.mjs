// Tournament strategy — sample K random prior attempts, pick the best by
// score, mutate against it. Diversifies parent selection vs pure greedy:
// occasionally revisits older-but-strong attempts the frontier has eclipsed.
//
// Use when: greedy has plateaued because the proposer keeps making local
//           moves and the search needs to "back up" to a better stem.
// Avoid when: history is short (< 5 scored attempts) — degenerates to greedy.

const TOURNAMENT_SIZE = 3;

export default {
  buildPrompt: (task) => task,

  selectParents(ctx) {
    const scored = ctx.history.filter((r) => typeof r.score === "number");
    if (scored.length === 0) {
      return [{ attempt_id: ctx.frontier.attempt_id, score: ctx.frontier.score, outcome: "scored" }];
    }
    // Sample TOURNAMENT_SIZE distinct indices using ctx.rng (deterministic).
    const k = Math.min(TOURNAMENT_SIZE, scored.length);
    const picked = new Set();
    while (picked.size < k) {
      picked.add(Math.floor(ctx.rng() * scored.length));
    }
    const sample = [...picked].map((i) => scored[i]);
    const winner = sample.reduce((best, r) => (r.score > best.score ? r : best));
    return [
      {
        attempt_id: winner.attempt_id,
        score: winner.score,
        outcome: winner.outcome,
        goal: winner.goal,
        rationale: winner.rationale,
        knobs: winner.knobs,
      },
    ];
  },

  mutationDirective(_ctx) {
    return "Mutate against the PARENT shown above (not necessarily the frontier). The strategy chose this parent via tournament selection — it may be older than the frontier, so consider directions the frontier abandoned.";
  },
};
