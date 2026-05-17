import type { StrategyContext } from "./contract.js";
import type { FrontierRecord } from "../state/frontier.js";
import type { EvolutionRow } from "../state/history.js";
import type { SpecSlice } from "../spec/parse.js";

/**
 * Build the read-only context passed to every strategy hook this iteration.
 * History is deep-frozen so a misbehaving harness can't mutate darwin's
 * in-memory state.
 */
export function buildContext(args: {
  iteration: number;
  mode: "harness" | "goal";
  frontier: FrontierRecord;
  history: EvolutionRow[];
  spec: SpecSlice;
  seed?: number;
}): StrategyContext {
  const ctx: StrategyContext = {
    iteration: args.iteration,
    mode: args.mode,
    frontier: Object.freeze({ ...args.frontier }),
    history: Object.freeze(args.history.map((r) => Object.freeze({ ...r }))),
    spec: Object.freeze({ task: args.spec.task, slug: args.spec.slug }),
    rng: mulberry32(args.seed ?? hashString(args.spec.slug || "darwin") + args.iteration),
  };
  return Object.freeze(ctx);
}

/** Tiny deterministic RNG (mulberry32). Same seed → same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
