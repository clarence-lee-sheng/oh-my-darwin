import { formatErrorSummary } from "../runtime/diagnostics.js";
import { writeTerminalError } from "../runtime/terminal.js";
import type { EvolutionRow } from "../state/history.js";
import type { FrontierRecord } from "../state/frontier.js";

const STRATEGY_HOOK_NAME_PREVIEW_CHARS = 120;

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
    writeTerminalError(
      `darwin: strategy hook ${formatStrategyHookName(hookName)} threw (${formatErrorSummary(e, 120)}); using default`,
    );
    return fallback();
  }
  if (!validate(result)) {
    writeTerminalError(
      `darwin: strategy hook ${formatStrategyHookName(hookName)} returned invalid shape; using default`,
    );
    return fallback();
  }
  return result;
}

export function formatStrategyHookName(value: unknown): string {
  return formatErrorSummary(value, STRATEGY_HOOK_NAME_PREVIEW_CHARS);
}

export const isParentArray = (v: unknown): v is ParentAttempt[] =>
  Array.isArray(v) && v.every(isParentAttempt);

export const isString = (v: unknown): v is string => typeof v === "string";

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export const isPopulation = (v: unknown): v is Population =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  isFrontierRecord((v as Partial<Population>).frontier) &&
  (
    (v as Partial<Population>).niches === undefined ||
    isNicheMap((v as Partial<Population>).niches)
  );

function isParentAttempt(value: unknown): value is ParentAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parent = value as Partial<ParentAttempt>;
  return (
    isNonEmptyString(parent.attempt_id) &&
    isNullableFiniteNumber(parent.score) &&
    isNonEmptyString(parent.outcome) &&
    optionalString(parent.goal) &&
    optionalString(parent.rationale) &&
    optionalStringRecord(parent.knobs)
  );
}

function isFrontierRecord(value: unknown): value is FrontierRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frontier = value as Partial<FrontierRecord>;
  return (
    isNonEmptyString(frontier.attempt_id) &&
    isNullableFiniteNumber(frontier.score) &&
    typeof frontier.t === "string"
  );
}

function isNicheMap(value: unknown): value is Record<string, NicheEntry> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isNicheEntry)
  );
}

function isNicheEntry(value: unknown): value is NicheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<NicheEntry>;
  return (
    isNonEmptyString(entry.attempt_id) &&
    typeof entry.score === "number" &&
    Number.isFinite(entry.score) &&
    typeof entry.niche === "string" &&
    optionalString(entry.run_dir)
  );
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string")
    )
  );
}
