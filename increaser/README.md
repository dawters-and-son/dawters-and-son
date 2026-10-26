# The Increaser

*Every pass, a little more.* The DAWters and Son suite's live looper: six loop "cups", hands-free punch-in
with a count-in, start-on-sound and stop-when-you-stop triggers, gated takes, retakes, progressive build-up
recipes, live tempo moves (pitch kept or tape), and optional USB / MIDI / game-pad pedals.
Free software under the GNU GPL v3 or later. Copyright (C) 2026 Josh Wilk.

- `python3 build.py` → `dist/increaser.html` (one self-contained page) and a web zip with a localhost launcher.
- The website (`tools/assemble_site.sh` in the repo root) builds it and serves it at `/increaser/`.
- **Send to DAWters** (Export tab) opens the studio at `#receive` and posts a `dawters-send` message of
  `kind: 'stems'`; from a file it saves a `.dawsuite.json` for File → Import from the suite.

## Source

- `src/engine.js` — the looper engine (runs in the AudioWorklet and renders exports offline): loop grid,
  layers, punch jobs, sound trigger, silence stop, gates, WSOLA time-stretch, test band, click, limiter.
- `src/app.js` — the interface; `src/style.css` — the "Demitasse" design system; `src/index.html` — page shell.
- `src/fonts/` — Yesteryear, Oswald, Courier Prime (SIL OFL 1.1, see `src/fonts/OFL.txt`).

## Tests

- `node tools/test_engine.js` — 18 engine checks (timing, pitch under tempo changes, layers, triggers, gates, CPU).
- `python3 tools/ui_check.py OUT` and `python3 tools/ui_triggers.py OUT` — headless Chromium walk-throughs
  with a fake microphone (needs Playwright); screenshots go to OUT.
