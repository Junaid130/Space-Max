# Archive — superseded work

The team's three branches diverged ("we were out of sync") and each carried a
different design of the same game. `main` now runs the **v2 controls design**
(`SKILL.md`, section "Mission design (v2)") from the `animations` branch, which
is the newest and only fully tested implementation (see `tests/`).

This folder keeps the work that the merge superseded, so nothing is lost.

| Folder | Origin | What it is | Why it is not live |
|---|---|---|---|
| `v1-rocket-builder/` | `origin/simulation` (`a6674a4`) | `data.js` (243 lines) + `sim.js` (1485 lines) for the original rocket-builder contract: rockets, engines, fuel slider, components, budget/mass/power limits, scored launches (per `3-ui-screens.md` at the repo root — the v1 handoff spec, still untracked). | Replaced by the v2 design: `SKILL.md` states the builder's raw math sliders were replaced by two notched controls per mission. Its `launch()` returns `{ success, score, stats }`, which no live UI or scene consumes. |
| `ui-screens-main/` | `main` (`7b6f9e3`) | `ui.js` (679 lines) — Person 3's map / briefing / builder / launch / results / end screens with `localStorage` progress. | Written against an outcome shape (`outcome.success`, `outcome.score.parts`, `failure.numbers`, `failures[type].story/fix/fact`) that no branch's `sim.js` ever produced: every launch would have rendered a failure screen and nothing would unlock. The `animations` `ui.js` (990 lines) is wired to the live data/sim/scene. |

Files are kept byte-identical to their source commits (`7b6f9e3` and
`a6674a4`); only the filenames were changed (extensions kept, directory
changed) so they cannot collide with the live `js/` files.

They are **not loaded by `index.html`** and are not part of the game.

## Restoring one of them

```sh
git show a6674a4:js/sim.js      # original path of the v1 simulator
git show 7b6f9e3:js/ui.js       # original path of the screens version
```

Re-integrating the v1 rocket-builder design would mean rebuilding a scene,
styles and a UI against `3-ui-screens.md` — a redesign, not a merge.
