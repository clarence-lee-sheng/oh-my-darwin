import { stderr } from "node:process";
import type { EvolutionRow } from "../state/history.js";
import type { FrontierRecord } from "../state/frontier.js";

/**
 * A read-only snapshot the strategy hooks see when deciding what to do
 * this iteration. The harness must not mutate these — copies are made
 * before handing them in.
 */
export interface StrategyContext {
  iteration: number;
  mode: "harness" | "goal";
  frontier: FrontierRecord;
  history: ReadonlyArray<EvolutionRow>;
  /** Spec slice (task, scorer, slug). Avoids re-parsing. */
  spec: { task: string; slug: string };
  /** Deterministic RNG seeded once per loop; useful for reproducibility. */
  rng: () => number;
}

/**
 * Subset of EvolutionRow visible to harness as a "parent" candidate.
 * Trimmed to the fields a strategy needs to make a selection decision.
 */
export interface ParentAttempt {
  attempt_id: string;
  score: number | null;
  outcome: string;
  goal?: string;
  rationale?: string;
  knobs?: Record<string, string>;
}

/**
 * The full population view the updatePopulation hook may modify. Today
 * darwin only tracks `frontier`; MAP-Elites strategies maintain `niches`.
 */
export interface Population {
  frontier: FrontierRecord;
  /** Optional niche grid (MAP-Elites). Keys are niche identifiers. */
  niches?: Record<string, NicheEntry>;
}

export interface NicheEntry {
  attempt_id: string;
  score: number;
  run_dir?: string;
  /** Free-form descriptor — e.g. "sandbox=workspace-write,model=gpt-5-codex". */
  niche: string;
}

/**
 * Strategy hook signatures. All hooks are optional on the harness; when
 * missing or when a call throws, darwin falls back to the default in
 * `./defaults.ts`.
 */
export interface StrategyHooks {
  selectParents?(ctx: StrategyContext): ParentAttempt[];
  mutationDirective?(ctx: StrategyContext): string;
  acceptCandidate?(candidate: unknown, ctx: StrategyContext): boolean;
  updatePopulation?(
    attempt: Pick<EvolutionRow, "attempt_id" | "score" | "run_dir" | "knobs">,
    population: Population,
    ctx: StrategyContext,
  ): Population;
}

/**
 * Invoke a strategy hook safely. If the hook is missing, throws, or
 * returns the wrong shape, log a one-line warning and return the default.
 *
 * Strategy hooks are user-authored JS. They must never crash the loop.
 */
export function safeHook<T>(
  hookName: string,
  hookFn: ((...args: any[]) => T) | undefined,
  args: any[],
  fallback: () => T,
  validate: (v: unknown) => v is T,
): T {
  if (typeof hookFn !== "function") return fallback();
  let result: unknown;
  try {
    result = hookFn(...args);
  } catch (e) {
    stderr.write(`darwin: strategy hook ${hookName} threw (${String(e).slice(0, 120)}); using default\n`);
    return fallback();
  }
  if (!validate(result)) {
    stderr.write(`darwin: strategy hook ${hookName} returned invalid shape; using default\n`);
    return fallback();
  }
  return result;
}

export const isParentArray = (v: unknown): v is ParentAttempt[] =>
  Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as any).attempt_id === "string");

export const isString = (v: unknown): v is string => typeof v === "string";

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export const isPopulation = (v: unknown): v is Population =>
  !!v && typeof v === "object" && !!(v as any).frontier && typeof (v as any).frontier.attempt_id === "string";
