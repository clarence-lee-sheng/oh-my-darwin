// MAP-Elites strategy — maintain a grid of best-per-niche, where niches
// are defined by the (sandbox, model) knob combination. Each cell holds
// the highest-scoring attempt that landed in it. The proposer sees the
// whole grid + a randomly-chosen niche elite to mutate against.
//
// Use when: the task benefits from diverse strategies (e.g. some niches
//           need a tighter sandbox, others a stronger model) — and you
//           want darwin to explore each cell rather than collapsing to one.
// Avoid when: knobs don't really matter for your task — the grid is just
//             overhead in that case.
//
// State:    .darwin/niches.json (darwin writes this for you when this
//           strategy returns niches from updatePopulation).

export default {
  buildPrompt: (task) => task,

  selectParents(ctx) {
    // Pull niches off the live evolution log (we don't have direct access
    // to the niches file from here, but we can reconstruct from history).
    const grid = reconstructGrid(ctx.history);
    const keys = Object.keys(grid);
    if (keys.length === 0) {
      // Cold start: no niches yet. Default to recent.
      return ctx.history.slice(-5).map(toParent);
    }
    // Pick a random niche elite to mutate against (encourages exploring
    // each cell, not just the best one).
    const k = keys[Math.floor(ctx.rng() * keys.length)];
    const elite = grid[k];
    return [
      {
        attempt_id: elite.attempt_id,
        score: elite.score,
        outcome: "scored",
        knobs: elite.knobs,
      },
    ];
  },

  mutationDirective(ctx) {
    const grid = reconstructGrid(ctx.history);
    const filled = Object.keys(grid).length;
    return `MAP-Elites grid currently has ${filled} niche(s) filled. The PARENT above is the elite of one randomly-chosen niche. You may either: (a) try to improve this niche's score with similar knobs, or (b) explicitly pick different knobs to land in an empty niche. The strategy values both.`;
  },

  updatePopulation(attempt, population, _ctx) {
    if (attempt.score === null || attempt.score === undefined) return population;
    const knobs = attempt.knobs ?? {};
    const niche = nicheKey(knobs);
    const niches = { ...(population.niches ?? {}) };
    const prev = niches[niche];
    if (!prev || attempt.score > prev.score) {
      niches[niche] = {
        attempt_id: attempt.attempt_id,
        score: attempt.score,
        run_dir: attempt.run_dir,
        niche,
      };
    }
    // Also do the standard greedy frontier replace.
    let frontier = population.frontier;
    if (frontier.score === null || attempt.score > frontier.score) {
      frontier = {
        attempt_id: attempt.attempt_id,
        score: attempt.score,
        t: new Date().toISOString(),
        run_dir: attempt.run_dir,
      };
    }
    return { frontier, niches };
  },
};

function nicheKey(knobs) {
  const sandbox = knobs.sandbox ?? "default";
  const model = knobs.model ?? "default";
  return `sandbox=${sandbox},model=${model}`;
}

function reconstructGrid(history) {
  const grid = {};
  for (const r of history) {
    if (typeof r.score !== "number" || !r.knobs) continue;
    const k = nicheKey(r.knobs);
    const prev = grid[k];
    if (!prev || r.score > prev.score) {
      grid[k] = { attempt_id: r.attempt_id, score: r.score, knobs: r.knobs };
    }
  }
  return grid;
}

function toParent(r) {
  return {
    attempt_id: r.attempt_id,
    score: r.score,
    outcome: r.outcome,
    goal: r.goal,
    rationale: r.rationale,
    knobs: r.knobs,
  };
}
