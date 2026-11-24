# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/torunghs/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/torunghs/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: it builds the same static sites byte for byte, faster. Written from scratch from the dialect's specification — same front matter, template dialect, Markdown subset, slug rule and report — with the hot paths rewritten for speed: Markdown is lexed and rendered in one pass with manual character scans, HTML escaping is a single scan, slugify has an ASCII fast path plus a cache, and templates are compiled to plain JavaScript functions (a tree-walking renderer is kept as a fallback when code generation is unavailable).

On the kit's practice set it answers all 3 cases identically to makefun-site 1.0.0 (and to the kit's expected output), deterministically, in roughly half the CPU time of the house baseline.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`), answers each with `run` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json` (or `/output/answers.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=7dkxfn6v&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
