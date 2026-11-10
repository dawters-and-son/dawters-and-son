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
   - **Melody**: harmonic-sum salience on 180 pitch candidates (80–640 Hz), a Viterbi path, voicing from the path
     salience; a harmonic comb on that path, weighted by a wide centre score, catches singers who are not centred.
   - **Bass line**: the same tracker on 30–240 Hz; its harmonic comb (up to 1.2 kHz) joins a 250 Hz crossover.
   - **Repetition**: the loop period from the autocorrelation of band energies, and an adaptive REPET model
     (median of the spectrum ±1 and ±2 periods away; Rafii & Pardo 2013) that keeps loops out of the centre part
     of the vocal estimate.
3. Masks are smoothed over three frames; "other" is the residual, so the sum is exact by construction.

Work is cut into chunks with margins and spread over a pool of Web Workers (one per core).

### Measured (`tools/sdr_test.js`, SDR in dB against the true stems)

| Song (MUSDB18 sample / test data) | Vocals | Drums | Bass | Band | Mean |
|---|---|---|---|---|---|
| Music Delta – 80s Rock (7 s) | 7.3 | 7.7 | 5.3 | 4.3 | 6.2 |
| The Easton Ellises – Falcon 69 (6 s, wide vocal) | 2.3 | 6.0 | 3.8 | 1.9 | 3.5 |
| Loop test (32 s: a looped backing under non-repeating vocals) | 6.3 | 7.9 | 6.0 | 3.5 | 5.9 |

The parameters were tuned on these by coordinate search (`proto/` in the build session). Tried and **not** used: a
stereo multichannel Wiener refinement (±0.2 dB, mixed across songs, and it breaks the exact sum) and stronger
REPET weighting (hurt vocals when pitch tracking already works). A trained separator (Demucs) is cleaner; this is
built for rebalancing and remastering, with a spectral editor for hand fixes.

**1.1 was withdrawn (1.1.1 restores this engine).** 1.1 replaced the vocal share with a pitch-comb vs
time-median-accompaniment Wiener competition and soft voicing (KAM / Ikemiya-style). It scored higher on SDR
(mean vocal 4.1 -> 5.7 dB on five MUSDB excerpts) but sounded worse in listening tests, so the metric is not
to be trusted on its own for vocals here; future changes need a listening check, not just SDR.

Speed: a 4-minute song presses in about 22 s on a 2-core machine in Chrome.

## The app

- **Press**: recipes (Balanced, Vocal focus, Beat-driven, Live & acoustic, Mono & vintage, Karaoke), 2/4/5 stems,
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
