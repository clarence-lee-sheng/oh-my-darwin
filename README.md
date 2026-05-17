# oh-my-darwin

The on-ramp to meta-harness for non-researchers. Turn "I have a task" into an iterative loop, without writing your own propose/evaluate/score machinery.

Built on top of the Codex CLI, with optional OMX (`oh-my-codex`) launch
support. See `darwin_spec.md` for the full design rationale.

## Quick start

```bash
npm install
npm link        # exposes `darwin` and `darwin-hook` on PATH

cd ~/your/project
darwin init     # interview produces .darwin/meta-spec.md
darwin baseline # run task once, capture starting score
# (darwin meta — the iterative loop — coming next)
```

To use OMX instead of raw Codex:

```bash
darwin --omx --madmax --xhigh baseline
# or make it the default for subcommands that spawn agents internally:
DARWIN_ENGINE=omx DARWIN_ENGINE_ARGS="--madmax --xhigh" darwin meta
```

## Commands today

- **`darwin`** — auto-installs `.codex/hooks.json` if missing, then launches the selected agent engine (Codex by default, OMX with `--omx`/`DARWIN_ENGINE=omx`). Every lifecycle event is logged to `.darwin/events.jsonl`.
- **`darwin init`** — adaptive Socratic interview (via the selected engine) that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition.
- **`darwin baseline`** — reads the spec, launches the selected engine interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json` and appends to `.darwin/evolution.jsonl`.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by the Codex/OMX hook surface; dispatches to the central event bus.

## Engine selection

Codex remains the default:

```bash
darwin "fix the failing tests"
darwin --codex baseline
```

OMX can be selected per invocation or through the environment:

```bash
darwin --omx "fix the failing tests"
darwin --engine omx baseline
DARWIN_ENGINE=omx darwin init
```

For subcommands that spawn agents internally (`init`, `baseline`, `meta`),
prepend engine launch flags either before the subcommand or with
`DARWIN_ENGINE_ARGS`:

```bash
darwin --omx --madmax --xhigh baseline
DARWIN_ENGINE=omx DARWIN_ENGINE_ARGS="--madmax --xhigh" darwin meta
```

When using OMX, Darwin defaults `OMX_LAUNCH_POLICY=direct` for child processes
so `baseline`/`meta` can wait for the interactive agent to exit and then ask for
the score. Explicit OMX flags such as `--tmux` still override that default.

## What's coming

- **`darwin meta`** — the loop: propose → validate → execute → score → update frontier → repeat.
- **`darwin status`** — frontier + recent attempts + deltas.
- **`darwin list`** — multi-project index.

## File layout in a darwin-managed project

```
your-project/
├── .codex/hooks.json           # auto-installed; tells Codex/OMX to call darwin-hook
└── .darwin/
    ├── meta-spec.md            # the spec (from `darwin init`)
    ├── frontier.json           # current best attempt
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw agent lifecycle events
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

v1 work-in-progress. Hook capture event names (`pre_tool_use` etc.) are placeholders pending verification against Codex/OMX hook behavior. Zero runtime deps; Node ≥ 20.
