# France's French Press

*Separate the grounds.*

A stem splitter and remaster studio in the DAWters and Son suite. Pour in a finished song and it is pressed into
**vocals, drums, bass, the band and the room** (or two stems for karaoke), then every stem gets its own channel
strip, editing and a mastering chain. Everything runs on the device: plain HTML + Web Audio + Web Workers, no
libraries, no network requests, **no machine-learning model**.

**Free software.** Copyright (C) 2026 Josh Wilk. GNU General Public License, version 3 or (at your option) any later
version — see [LICENSE](LICENSE). Fonts: Yesteryear, Oswald, Courier Prime (SIL OFL 1.1). MP3: lamejs 1.2.1
(LGPL-3.0, `vendor/lamejs-LICENSE.txt`).

## How the press works

Each stem is a soft mask over the song's short-time spectrum; for every bin the masks add up to one, so the stems
add back up to the song exactly (measured: largest difference about −145 dB).

1. **Drums** (STFT 2048 / hop 512): harmonic–percussive separation by median filtering across time and across
   frequency (Fitzgerald 2010; Driedger, Müller & Disch 2014), with a longer time median below 250 Hz. A **kick
   detector** takes what rises above a morphological opening of the low band (the sustained floor), because kicks
   are too long and too narrow for HPSS alone.
2. **The rest** (STFT 4096 / hop 1024), from the song minus the drums:
   - **Stereo**: pan position and phase agreement per bin (Avendano 2003; Barry, Lawlor & Coyle 2004) give a
     centre score; time-smoothed inter-channel coherence gives the **room** (Avendano & Jot 2004).
   - **Melody**: harmonic-sum salience on 180 pitch candidates (80–640 Hz) and a Viterbi path.
   - **Soft voice detection** (1.1): z-scores of path salience, vocal-band energy and the *novelty* of the comb's
     energy against a 1 s time median, through a sigmoid — a 0–1 "someone is singing" weight per frame.
   - **Vocal vs band competition** (1.1, kernel additive modelling backfitting — Liutkus, Fitzgerald, Rafii, Pardo &
     Daudet 2014 — with harmonic masks after Ikemiya, Itoyama & Yoshii 2016): on the tracked harmonics all energy
     is candidate vocal (the stereo centre only weighs 50%), the accompaniment is modelled as what holds steady over
     2 s (time median of the current accompaniment estimate), and a squared Wiener mask settles each bin; twice.
   - **Bass line**: the same tracker on 30–240 Hz; its harmonic comb (up to 1.2 kHz) joins a 250 Hz crossover.
3. Masks are smoothed over three frames; "other" is the residual, so the sum is exact by construction.

Work is cut into chunks with margins and spread over a pool of Web Workers (one per core).

### Measured (SDR in dB against the true stems; `tools/vocal_test.js`, `tools/sdr_test.js`)

Vocals, version 1.0 → 1.1:

| Song | 1.0 | 1.1 |
|---|---|---|
| Music Delta – 80s Rock (MUSDB18 sample, 7 s) | 7.3 | 9.6 |
| The Easton Ellises – Falcon 69 (6 s, wide vocal) | 2.3 | 3.0 |
| Cristina Vane – So Easy (MUSDB18 test, 30 s) | 3.6 | 6.1 |
| The Mountaineering Club – Mallory (MUSDB18 test, 30 s) | 4.2 | 4.7 |
| Triviul feat. The Fiend – Widow (MUSDB18 test, 30 s) | 3.0 | 5.0 |
| **Mean** | **4.1** | **5.7** |

In 1.1 the vocal stem keeps about twice as much of the singer (−5.4 → −2.4 dB of the true vocal's energy) while
less of the band leaks in (signal-to-interference 6.6 → 8.0 dB). On the 4-stem samples drums are unchanged and
bass/band improve (Rock: drums 7.7, bass 6.1, band 5.5). For scale: a perfect (oracle) mask at this resolution
scores 9–15 dB; trained separators reach roughly 7–9 dB on MUSDB vocals.

Investigated and **not** adopted (measured no gain or a loss): REPET-SIM similarity kernels, a stereo multichannel
Wiener post-filter, an inter-harmonic octave penalty and peaks-only salience (fixed one song, broke another),
a second pitch comb for harmony vocals, 2048 and 8192 windows. Re-tracking the pitch on the separated vocal
(Ikemiya's mutual step) gained 0.06 dB for a whole extra pass, so it is left out.

Speed: a 4-minute song presses in about 36 s on a 2-core machine in Chrome (more cores, faster).

## The app

- **Press**: recipes (Balanced, Vocal focus, Clean vocal, Live & acoustic, Mono & vintage, Karaoke), 2/4/5 stems,
  fine-tuning sliders, progress with stages, a report (levels, exact-sum check, tempo guess, melody coverage).
- **Edit**: stacked lanes in Waveform or Spectral view. Select across lanes (level, silence, fade in/out, move to
  another stem) or draw a time × frequency box in Spectral view (move that sound to another stem, turn it down,
  remove it). Undo/redo; every edit is logged and replayed when a project is opened.
- **Mix**: per stem EQ (HP, low shelf, three bells, high shelf, LP; draggable graph), compressor with gain
  reduction, saturation, width with mono-below, pan, fader, mute/solo; quick moves (Vocal forward, Punchier drums,
  Tighter low end, Wider band, Karaoke, A cappella, Drumless, Bassless…).
- **Master**: EQ, glue compressor, tape, width, limiter; six recipes; live loudness (approximate), spectrum of the
  remaster over the level-matched original; Analyse (exact BS.1770 integrated loudness, LRA, 4× true peak) and
  Match target with a look-ahead true-peak limiter. A/B flips to the original at the remaster's loudness.
- **Export**: remaster, processed stems, raw stems; WAV 16/24/32f or MP3 320/256/192; master to target, as mixed
  or peak-normalised; one zip. Projects save as `.frenchpress` (the song + settings + edit log). Autosave resumes
  the last session.

## Build and test

```
python3 build.py                 # -> dist/frenchpress.html (one file) + dist/French-Press-<V>-web.zip
sh android/build-apk.sh          # -> android/build/French-Press-<V>.apk (offline: aapt, javac, dx, zipalign, apksigner)
node tools/vocal_test.js         # vocals, 1.0 vs 1.1 engine, on five songs with true stems
node tools/sdr_test.js rock      # needs <name>_{mix,vocals,drums,bass,other}.wav in /home/claude/testdata
python3 tools/ui_check.py /tmp/shots   # headless Chrome: demo -> press -> every tab -> edits -> export, console errors
python3 tools/long_test.py song.wav    # timing on a long song
```

APK: package `com.wilk.frenchpress`, minSdk 24, targetSdk 28, no INTERNET permission. Songs open with the file
picker or from other apps (Open with / Share); exports go to `Music/France's French Press/`. Release key:
`FRENCHPRESS_KEYSTORE` + `FRENCHPRESS_KS_PASS` (+ `FRENCHPRESS_KS_ALIAS`); never in the repository.

## Layout

- `src/dsp.js` — FFT, STFT, stage A/B separation, pitch tracking, spectrograms, spectral moves, loudness, limiter,
  WAV/zip; also the worker entry point
- `src/engine.js` — chunking, worker orchestration, overlap-add into the stem buffers
- `src/audio.js` — channel strips, master chain, transport, meters, offline render
- `src/ui.js` — knobs, faders, the EQ graph, menus, dialogs
- `src/app.js` — controller (views, editing, projects, export, demo song)
- `src/style.css` — "Bistro" design system; `src/logo.svg`, `src/icon.svg`
- `android/` — WebView shell; `tools/` — tests
