import type {
  ParentAttempt,
  Population,
  StrategyContext,
} from "./contract.js";
import type { EvolutionRow } from "../state/history.js";

/**
 * Default behaviors for the 5 strategy hooks. These match the loop's
 * behavior before evolutionary strategies existed:
 *
 *   - selectParents     → [frontier] (or last 5 history rows if no frontier)
 *   - mutationDirective → "" (proposer gets no extra instructions)
 *   - acceptCandidate   → always accept
 *   - updatePopulation  → greedy replace if attempt.score > frontier.score
 */

export function defaultSelectParents(ctx: StrategyContext): ParentAttempt[] {
  const recent = ctx.history.slice(-5);
  if (recent.length === 0) {
    return [
      {
        attempt_id: ctx.frontier.attempt_id,
        score: ctx.frontier.score,
        outcome: "scored",
      },
    ];
  }
  return recent.map(toParent);
}

export function defaultMutationDirective(_ctx: StrategyContext): string {
  return "";
}

export function defaultAcceptCandidate(_candidate: unknown, _ctx: StrategyContext): boolean {
  return true;
}

export function defaultUpdatePopulation(
  attempt: Pick<EvolutionRow, "attempt_id" | "score" | "run_dir" | "knobs">,
  population: Population,
  _ctx: StrategyContext,
): Population {
  if (attempt.score === null || attempt.score === undefined) return population;
  const cur = population.frontier.score;
  if (cur === null || attempt.score > cur) {
    return {
      ...population,
      frontier: {
        attempt_id: attempt.attempt_id,
        score: attempt.score,
        t: new Date().toISOString(),
        run_dir: attempt.run_dir,
      },
    };
  }
  return population;
}

export function toParent(r: EvolutionRow): ParentAttempt {
  return {
    attempt_id: r.attempt_id,
    score: r.score,
    outcome: r.outcome,
    goal: r.goal,
    rationale: r.rationale,
    knobs: r.knobs,
  };
}
