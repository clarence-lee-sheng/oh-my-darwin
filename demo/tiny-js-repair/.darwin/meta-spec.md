# oh-my-darwin meta-spec — tiny-js-repair-demo

## Task
Fix `src/slugify.js` so the local deterministic scorer passes. Success means `npm test` prints `score: 1`. Do not edit `check.mjs`, `score.mjs`, `package.json`, or `.darwin/*`; the intended repair is the implementation in `src/slugify.js`.

## Scorer
- name: deterministic slugify score
- direction: higher_is_better
- source: test-suite
- threshold_good: 1
- threshold_done: 1
- command: npm test

## Constraints
- HARD: Local-only; no network, package installs, credentials, or external services.
- HARD: Do not edit the scorer or checks: `check.mjs`, `score.mjs`, `package.json`, `.darwin/*`.
- HARD: Keep the fix minimal and explain it in the final response.
- SOFT: Prefer a small readable regex pipeline over a dependency.

## HITL
- pattern: autonomous
- BEFORE: None for harness-mode demo; the spec and seeded frontier are already approved.
- DURING: Stop if the agent tries to install dependencies or edit scorer files.
- AFTER: Human verifies with `npm test`, `darwin status`, and `.darwin/evolution.jsonl`.

## Surface
- The proposer may vary the prompt/harness text only.
- The executor may edit `src/slugify.js` only.
- Project-scoped skills/hooks are disallowed for this tiny live fixture; use the root repo tests for the capability-promotion second act.

## Capabilities
- skills: disallowed for the live repair fixture
- hooks: disallowed for the live repair fixture
- agents: disallowed
- promotion: not needed in this fixture; demonstrate capability promotion from the root repo tests instead

## Stop condition
Stop when score reaches 1 or after one live iteration during the hackathon demo.

## Hypothesis going in
A deterministic local scorer plus a tiny repo makes the agent's success legible while Darwin's frontier/evolution artifacts make the harness loop visible.
