# Palmer Penguins insights demo for oh-my-darwin

This is a non-code analytics/reporting demo using the public Palmer Penguins dataset.

Dataset source: `palmerpenguins` by Allison Horst, Alison Hill, and Kristen Gorman; data are CC0. Upstream CSV used here: https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv

```bash
cd demo/penguins-insights
npm test                              # expected before report: score: 0
node ../../dist/cli/index.js status   # shows seeded baseline frontier score 0
node ../../dist/cli/index.js --omx meta --iterations 1 --duration 8m
npm test                              # target after report: score: 10
cat score-details.json
node ../../dist/cli/index.js status
cat .darwin/evolution.jsonl
```

The live deliverable is `insights.json`, not code. This helps show Darwin as a repeatable workflow optimizer for analytics/reporting tasks, not just software repair.
