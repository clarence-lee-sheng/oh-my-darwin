# oh-my-darwin

The on-ramp to meta-harness for non-researchers. Turn "I have a task" into an iterative loop, without writing your own propose/evaluate/score machinery.

Built on top of the Codex CLI. See `darwin_spec.md` for the full design rationale.

## Quick start

```bash
npm install
npm link        # exposes `darwin` and `darwin-hook` on PATH

cd ~/your/project
darwin init     # interview produces .darwin/meta-spec.md
darwin baseline # run task once, capture starting score
# (darwin meta — the iterative loop — coming next)
```

## Commands today

- **`darwin`** — auto-installs `.codex/hooks.json` if missing, then launches Codex (passthrough args). Every Codex lifecycle event is logged to `.darwin/events.jsonl`.
- **`darwin init`** — adaptive Socratic interview (via Codex) that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition.
- **`darwin baseline`** — reads the spec, launches Codex interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json` and appends to `.darwin/evolution.jsonl`.
- **`darwin meta`** — the loop. Each iteration proposes a candidate, executes it, scores the result, and updates the frontier if the score improves. Two execution modes:
  - **harness-mode (default)** — proposer writes a `harness.mjs` that transforms the task prompt; Codex runs the transformed prompt once per attempt.
  - **`darwin meta --goal-mode`** — proposer outputs `{goal, knobs, rationale}` JSON; each attempt sends `/goal <text>` to Codex and lets it run autonomously until quiet (no new tool activity for `--attempt-quiet 60s` after the last stop) or `--attempt-max 30m`. HITL prompt approves each proposed goal before it runs.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by Codex's hook system; dispatches to the central event bus. Real hook events captured: `pre_tool_use`, `post_tool_use`, `session_start`, `user_prompt_submit`, `stop`.

## What's coming

- **`darwin status`** — frontier + recent attempts + deltas.
- **`darwin list`** — multi-project index.

## File layout in a darwin-managed project

```
your-project/
├── .codex/hooks.json           # auto-installed; tells Codex to call darwin-hook
└── .darwin/
    ├── meta-spec.md            # the spec (from `darwin init`)
    ├── frontier.json           # current best attempt
    ├── niches.json             # MAP-Elites grid (only if that strategy is used)
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw Codex lifecycle events
    ├── harness/harness.mjs     # active harness — also carries the strategy hooks
    ├── runs/<attempt-id>/      # per-attempt trajectories + artifacts
    ├── init/transcript.jsonl   # interview transcript
    └── plugins/*.mjs           # opt-in user plugins (rarely needed)
```

## Evolutionary strategies

The active harness file (`.darwin/harness/harness.mjs`) is also where the
**evolutionary strategy** lives — selection, mutation guidance, acceptance,
and population update are all optional hooks on the same exported object.
Defaults reproduce darwin's greedy single-frontier behavior, so existing
harnesses still work unchanged.

| Hook                        | Decides                                              | Default                          |
|-----------------------------|------------------------------------------------------|----------------------------------|
| `selectParents(ctx)`        | Which prior attempts the proposer sees this iter     | Last 5 history rows              |
| `mutationDirective(ctx)`    | Free-form steering string injected into the prompt   | `""` (no extra steering)         |
| `acceptCandidate(c, ctx)`   | Whether to execute the candidate (post-propose)      | Always accept                    |
| `updatePopulation(a, p, c)` | New frontier + optional niche grid after each attempt | Replace frontier if score better |

`ctx` is read-only and includes the iteration number, mode (`harness` or
`goal`), the current frontier, recent history, the spec, and a
deterministic RNG. Failing hooks log a warning and fall back to defaults —
the loop never crashes from a bad strategy.

Four reference strategies live in `templates/strategies/`:

- **greedy.mjs** — default behavior, made explicit. Always mutates against
  the frontier.
- **tournament.mjs** — sample 3 random prior attempts, pick the best, mutate
  against it. Diversifies parent selection vs pure greedy.
- **novelty.mjs** — bias toward attempts whose goal text is most distant
  (token-Jaccard) from the frontier. Encourages exploration.
- **map-elites.mjs** — maintain a grid of best-per-niche
  (`sandbox × model`). Proposer sees a random niche elite each iter.
  Writes `.darwin/niches.json` alongside `frontier.json`.

To use one: copy it to `.darwin/harness/harness.mjs` before running
`darwin meta`. (Or let the proposer evolve its own strategy hooks over
iterations — they're just methods on the harness object.)

## Plugin SDK (preview)

Drop a file into `.darwin/plugins/echo.mjs`:

```js
export default {
  name: "echo",
  handlers: {
    pre_tool_use: (p) => console.error("[echo]", JSON.stringify(p)),
  },
};
```

Auto-loaded on the next hook invocation.

## Status

v1 work-in-progress. Hook event names verified against Codex 0.130.0. Zero runtime deps; Node ≥ 20.
