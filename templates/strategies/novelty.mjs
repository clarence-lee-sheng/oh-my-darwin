// Novelty strategy — bias parent selection toward attempts whose goals
// are textually distant from the frontier's goal. Uses token-Jaccard as a
// cheap stand-in for semantic distance (no embeddings, no deps).
//
// Use when: the proposer keeps producing similar candidates and you want
//           to encourage exploration of approaches that look different.
// Avoid when: textual distance is a poor proxy for behavioral diversity
//             (e.g. tasks where small wording changes flip outcomes).
// Note:      In harness-mode this looks at goal text from history rows.
//            For harness-mode without goal-text history, falls back to
//            recent-K behavior.

export default {
  buildPrompt: (task) => task,

  selectParents(ctx) {
    const withGoals = ctx.history.filter((r) => typeof r.goal === "string" && r.goal.trim());
    if (withGoals.length === 0) {
      return ctx.history.slice(-5).map(toParent);
    }
    // Find the most recent frontier-promoting attempt's goal as the anchor.
    const anchor = withGoals
      .slice()
      .reverse()
      .find((r) => r.attempt_id === ctx.frontier.attempt_id);
    const anchorTokens = anchor ? tokens(anchor.goal) : new Set();

    // Rank prior goals by distance (1 - Jaccard) descending. Return top 3.
    const ranked = withGoals
      .map((r) => ({
        row: r,
        distance: 1 - jaccard(tokens(r.goal), anchorTokens),
      }))
      .sort((a, b) => b.distance - a.distance)
      .slice(0, 3)
      .map((x) => toParent(x.row));

    return ranked;
  },

  mutationDirective(_ctx) {
    return "These parents were selected because their approaches differ MOST from the current frontier. Lean into an approach that looks different from what the frontier is doing, not a refinement of it.";
  },
};

function tokens(s) {
  return new Set(
    String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
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
