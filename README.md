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
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by Codex's hook system; dispatches to the central event bus.

## What's coming

- **`darwin meta`** — the loop: propose → validate → execute → score → update frontier → repeat.
- **`darwin status`** — frontier + recent attempts + deltas.
- **`darwin list`** — multi-project index.

## File layout in a darwin-managed project

```
your-project/
├── .codex/hooks.json           # auto-installed; tells Codex to call darwin-hook
└── .darwin/
    ├── meta-spec.md            # the spec (from `darwin init`)
    ├── frontier.json           # current best attempt
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw Codex lifecycle events
    ├── runs/<attempt-id>/      # per-attempt trajectories + artifacts
    ├── init/transcript.jsonl   # interview transcript
    └── plugins/*.mjs           # opt-in user plugins (rarely needed)
```

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

v1 work-in-progress. Hook capture event names (`pre_tool_use` etc.) are placeholders pending verification against Codex's actual hook docs. Zero runtime deps; Node ≥ 20.
