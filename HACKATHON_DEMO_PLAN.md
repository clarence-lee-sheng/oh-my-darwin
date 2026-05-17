# oh-my-darwin hackathon demo plan

Date: 2026-05-17

## Decision

Demo **deterministic local repair with a seeded failing frontier**, then use **capability promotion + strategy hooks** as the differentiating second act.

The live demo should not be a broad web/research task. It should be a tiny repo with a programmatic scorer so the audience can see: baseline score `0` → Darwin proposes/executes one harness iteration → score `1` → durable artifacts in `.darwin/`.

Prepared fixture: `demo/tiny-js-repair/`.

## Why this is the safest winner

- **High probability of live success:** the target bug is one small implementation file, `src/slugify.js`; the scorer is local and binary.
- **Objective success signal:** `npm test` prints `score: 0` or `score: 1` and exits accordingly.
- **Shows Darwin, not just an agent:** the visible product is `.darwin/meta-spec.md`, `frontier.json`, `evolution.jsonl`, `runs/`, `proposals/`, and strategy/capability surfaces.
- **Avoids flaky dependencies:** no browser, external APIs, emails, payments, network calls, or long-running research.
- **Differentiates from generic harnesses:** generic frameworks orchestrate agents; Darwin asks the user for a task spec, binds it to a scorer/constraints/HITL/surface, and evolves the harness with durable local evidence.

## Live runbook: main path (8–12 minutes)

From repo root:

```bash
npm test
```

This proves the Darwin repo itself is healthy.

Then:

```bash
cd demo/tiny-js-repair
npm test                              # expected before repair: score: 0
node ../../dist/cli/index.js status   # seeded frontier: baseline score=0; unregistered is OK for this fixture
node ../../dist/cli/index.js --omx meta --iterations 1 --duration 8m
npm test                              # target after repair: score: 1
node ../../dist/cli/index.js status
cat .darwin/evolution.jsonl
find .darwin -maxdepth 3 -type f | sort
```

If OMX is unavailable or slow, replace `--omx` with `--codex`.

Important: do **not** run `darwin baseline` live for this fixture. The baseline is seeded at score `0` so the demo shows an improvement step instead of risking the baseline agent fixing the bug immediately.

## Backup path if the live agent stalls

1. Keep the failing fixture visible: `npm test` → `score: 0`.
2. Show the seeded spec and frontier:
   - `demo/tiny-js-repair/.darwin/meta-spec.md`
   - `demo/tiny-js-repair/.darwin/frontier.json`
3. Run deterministic repo tests:
   - `npm test` from repo root.
4. Walk through these proof points:
   - `test/spec-scorer.test.mjs`: command/test-suite scorers produce objective numeric scores.
   - `test/capabilities.test.mjs`: Darwin validates and promotes project-scoped skills/hooks safely.
   - `templates/strategies/*.mjs`: greedy, tournament, novelty, and MAP-Elites strategy hooks.
   - `src/cli/meta.ts`: loop stages: propose, validate, execute, score, promote capabilities, update frontier.

## More measurable demo examples

See `MEASURABLE_DEMO_EXAMPLES.md` for six concrete demo options with commands and before/after metrics:

1. Deterministic code repair loop: `score: 0 → score: 1`, frontier `0 → 1`, evolution rows `1 → 2`.
2. Tamper-resistant scorer guard: edited checks score zero.
3. Capability promotion safety: one skill + one hook promoted, overwrite rejected, stale edit detected.
4. Strategy templates: greedy/tournament/novelty/MAP-Elites as visible optimization policies.
5. Spec/scorer parser correctness: markdown spec becomes command/test-suite scoring.
6. Hook/event visibility: `.codex/hooks.json` and `.darwin/events.jsonl` show trace evidence.

7. Non-code existing dataset analytics: Palmer Penguins `0/10 → 10/10` report completeness, using `demo/penguins-insights/`.

## Ranked demo candidates

| Rank | Use case | Determinism | Demo value | Verdict |
|---:|---|---|---|---|
| 1 | Tiny local code repair with test-suite scorer | Very high | Shows objective frontier improvement | **Use as main demo** |
| 2 | Safe capability promotion | Very high | Shows Darwin can improve future agent context via project skills/hooks | Use as second act or backup |
| 3 | Strategy template swap: greedy → novelty/MAP-Elites | High | Shows evolutionary harness search, not a fixed agent loop | Use as talk-track + file tour |
| 4 | Research brief optimization | Medium | Good story, but slower and scorer may be subjective | Avoid for 1-hour hackathon live path |
| 5 | Make-money / purchases / live browser task | Low | Memorable, but flaky and risky | Do not use live |

## 60-minute prep schedule

- 0–10 min: run root `npm test`; confirm fixture `npm test` fails with `score: 0`.
- 10–20 min: dry-run `node ../../dist/cli/index.js status` inside fixture; rehearse the talk track.
- 20–40 min: attempt one live `darwin meta --iterations 1`; if it passes, leave the repaired state for screenshots, then reset `src/slugify.js` before judging.
- 40–50 min: prepare terminal panes: README, fixture spec, evolution log, strategy templates, capability test.
- 50–60 min: rehearse the exact 2-minute explanation below.

## Two-minute explanation

> Most agent demos show a model doing a task once. oh-my-darwin is different: it turns a task into an optimization loop. The user or interview produces a local `meta-spec.md` with task, scorer, constraints, HITL, and allowed mutation surface. Darwin records a baseline frontier, asks an agent to propose a harness variant, executes it, scores the result with the declared scorer, and only promotes the new frontier if the score improves. The same loop can also promote safe project-scoped skills/hooks for the next iteration. So this is not a replacement for Codex, OMX, LangGraph, or AutoGen; it is the on-ramp that lets non-researchers apply meta-harness optimization to their own task with plain files and objective evidence.

## Research basis

- Meta-Harness motivates the claim that harness code/context can materially change model performance and that raw logs/traces are valuable feedback for the proposer: https://yoonholee.com/meta-harness/ and https://arxiv.org/abs/2603.28052
- LangGraph is a low-level runtime for long-running stateful agents with durable execution/HITL; Darwin's contrast is the task-specific meta-loop and local scorer/frontier artifacts: https://docs.langchain.com/oss/python/langgraph/overview
- LangChain/LangSmith agent eval docs emphasize trajectory/rubric evaluation; Darwin should lean into deterministic scorers and append-only local evolution logs for the hackathon: https://docs.langchain.com/oss/python/langchain/test/evals
- OpenAI Agents SDK provides tracing for runs; Darwin's demo should show that tracing/evidence feeds a repeatable optimization loop: https://openai.github.io/openai-agents-python/tracing/
- AutoGen and CrewAI are strong orchestration/multi-agent workflow frameworks; Darwin's differentiator is wrapping existing agents with spec/scorer/frontier/evolution rather than authoring a new multi-agent app: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html and https://docs.crewai.com/en/introduction
