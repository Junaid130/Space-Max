# Tests — verification harness

Headless-browser + Node checks for the five-mission game. Everything here is
**test-only**: the game itself loads no test code.

## Prerequisites

1. **Serve the repo root** (any static server works):

   ```sh
   python3 -m http.server 8000        # run from the repo root
   ```

2. **Chromium** at `/usr/bin/chromium-browser` (override the path in a script
   if yours differs) and `puppeteer-core` available to Node:

   ```sh
   npm i puppeteer-core
   ```

3. *(Optional but recommended)* a **local copy of the pinned Three.js build**,
   so runs don't depend on cdnjs being up:

   ```sh
   curl -o tests/three.min.js https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
   ```

   Without it, scripts skip request interception and let the page fetch the CDN
   directly (network required).

## Environment overrides

| Var | Default | Used by |
| --- | --- | --- |
| `BASE` | `http://127.0.0.1:8000` | all browser scripts |
| `THREE_MIN` | `tests/three.min.js` | all browser scripts |
| `REPO` | repo root (`..` of `tests/`) | `sim-test.js` |

## The scripts

| Script | What it verifies | Runtime |
| --- | --- | --- |
| `sim-test.js` | Pure logic: `data.js` + `sim.js` — all 5 win combos, all 29 losing combos, evaluation order (comboFails → first wrong control → safety net), no answer leak in gauges. **56 checks.** | ~1 s |
| `test.js` | Scene contract in a real browser: WebGL boots, exactly one canvas, `init()` idempotent, all 25 preview clips report phases, failure alert + Mars card + image card appear, `onDone` **exactly once** on natural completion (8–12 s), skip, supersede, `over_budget`, 10-replay DOM stability, normal-play expectations. **26 checks.** | ~2 min |
| `gameflow.js` | End-to-end UX: campaign (5 cards, unlock gating) → briefing → build (2 notched controls, 6 choices, LAUNCH gating) → wrong combo → failure results + knowledge → retry with win combo → `Mission Complete!` → Mission 2 unlocked → SKIP reaches results fast → progress persisted. **23 checks.** | ~2 min |
| `diag.js` | One-off diagnostic: measures headless rAF fps and samples run progression frame-by-frame (used to root-cause the dt-clamp slow-motion bug). | ~25 s |
| `skipdbg.js` | One-off diagnostic: probes the SKIP button's hit-testing (`elementFromPoint`, `pointer-events`) and whether a real pointer click settles to results. | ~20 s |

## Run them

```sh
cd tests
node sim-test.js          # fast, no server needed
node test.js              # server must be running
node gameflow.js          # server must be running
```

Artifacts land in `tests/shots/*.png`, `result.json`, `clip-report.json`, and
`gameflow.json` — all git-ignored.

**Note:** run the two browser suites **sequentially** (each pins ~5 fps of
software WebGL; concurrent runs make timing assertions flaky).
