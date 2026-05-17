# Tiny JS repair demo for oh-my-darwin

This intentionally starts with a failing `src/slugify.js` implementation so a live agent can repair it under an objective scorer.

```bash
cd demo/tiny-js-repair
npm test                              # expected before live repair: score: 0
node ../../dist/cli/index.js status   # shows seeded baseline frontier score 0; unregistered is OK for this fixture
node ../../dist/cli/index.js --omx meta --iterations 1 --duration 8m
npm test                              # target after repair: score: 1
node ../../dist/cli/index.js status
cat .darwin/evolution.jsonl
```

If OMX is unavailable, use `--codex` instead of `--omx`. Do **not** run `darwin baseline` live for this fixture; the baseline is seeded so the demo can show an improvement step rather than risk the baseline agent fixing the task immediately.
