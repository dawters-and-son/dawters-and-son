# DAWters and Son — v2.3.3

**Free software.** Copyright (C) 2026 Josh Wilk. Licensed under the GNU General Public License,
version 3 or (at your option) any later version — see [LICENSE](LICENSE). Bundled third-party parts
(FFmpeg, Electron, fonts) keep their own licenses; see `vendor/THIRD-PARTY.txt`.
No price, no tiers, no sign-up, no tracking: the app makes no network requests.

A multitrack recording studio in the spirit of n-Track Studio and Cakewalk Project5, with a
Mixbus-style console and a mastering master bus. One codebase (plain HTML + Web Audio + AudioWorklet
processors, no UI libraries, works offline; ffmpeg for compressed exports) ships three ways:

| Build | File | Notes |
|---|---|---|
| Mac (Apple Silicon) | `dist/DAWters-and-Son-2.2-arm64.dmg` | Electron 45 shell, ad-hoc signed — first launch needs *Open Anyway* in Privacy & Security; native ffmpeg inside |
| Android 7.0+ | `dist/DAWters-and-Son-2.2.apk` | WebView shell, phones and tablets, saves to `Music/DAWters and Son/`; ffmpeg.wasm inside |
| Windows 10/11 (x64) | `dist/DAWters-and-Son-2.3.3-Setup-x64.exe` (+ `-win-x64-portable.zip`) | Same Electron shell; per-user NSIS installer (no admin), Start-menu **D&S Tuner** shortcut, `.dawters` association, native ffmpeg.exe; unsigned → SmartScreen *More info › Run anyway* |
| Ubuntu / Debian (amd64) | `dist/DAWters-and-Son-2.3.3-amd64.deb` | Same Electron shell; launcher + **D&S Tuner** launcher, `application/x-dawters` file type, hicolor icons, static ffmpeg, AppArmor profile for Ubuntu 24.04's user-namespace restriction |
| Localhost web | `dist/DAWters-and-Son-2.2-web.zip` | Double-click the starter → `http://localhost:8737`; also runs straight from `index.html` in Chrome (WAV export only that way) |

## Phase 1 features

**Recording** — any number of tracks, arm several at once, per-track input (In 1 / In 2 / In 1+2),
input monitoring through the channel strip, count-in, metronome, punch in/out with pre-roll,
loop recording that lays each pass down as a take (newest on top), sample-accurate capture with
latency compensation (estimate, speaker-and-mic calibration, manual nudge), live waveform while recording.

**Editing** — non-destructive clips: move (across tracks), copy (Ctrl-drag), trim both edges, fade
handles, clip gain, split, duplicate, cut/copy/paste, normalize, reverse, mute, bring to front,
properties dialog, export a clip as WAV. Overlapping clips: the one on top wins (with micro-fades at cuts).
Range selection across tracks (Audacity-style): loop it, punch it, split at its edges, delete with or
without closing the gap, insert silence. Snap (bar/beat/1/8/1/16/1/32, Alt to bypass), markers,
volume and pan envelopes per track, unlimited undo/redo.

**Console** (knob-per-function, Mixbus-style) — per track: trim, polarity, HPF, LPF, 4-band EQ
(proportional-Q bells + shelves), gate, compressor with Leveler / Compressor / Limiter modes and a
gain-reduction meter, 2× oversampled tape saturation, four inserts, four mixbus sends (pre/post),
pan, fader, peak meter. Four mixbuses (tone, compression, tape, pan, fader). Master: tone,
bus compressor, tape, look-ahead brickwall limiter with ceiling, peak / K-20 / K-14 / K-12 metering,
BS.1770 loudness (momentary, short-term, integrated, LRA), true-peak readout, correlation meter.

**Inserts** (registry in `src/fx.js` — the hook for Web Audio Modules / a native VST host later):
Sun Hall Reverb, Echo Ripple Delay (tempo sync, ping-pong), Kaleido Chorus/Flanger, Prism Phaser,
Wobble Tremolo, Tangerine Tube Drive, Rainbow 10-band Graphic EQ.

**Files** — `.dawters` song files (zip with project JSON + 32-bit float WAVs), autosave on the device,
import WAV/MP3/OGG/FLAC/M4A (drag and drop too), offline export of stereo mixdown or stems (zip),
16-bit dithered / 24 / 32-float, 44.1/48/96 kHz, tail, normalize; export reports peak and integrated LUFS.

## v2.3.3 — free software under the GPL

- Licensed GPL-3.0-or-later: `LICENSE` at the top of the project, an SPDX header in every source file,
  and the license in every download (Mac disk image, Windows installer license page and app folder,
  Debian `copyright` file, web zip). Help › About shows the notice and a **License** button with the full text.
- The Android build script reads its signing key from the environment instead of the repository.

## v2.3.2 — recording over a track replaces what's there

**The bug:** recording on a track that already had audio kept playing the old audio under the new take.

**The fix:**
- While recording, an armed audio track's existing clips are silent in the covered range: from the record start onward, the punch range when punch is on, or the whole loop (and from the record start) when loop-recording.
- Pre-roll and count-in before the range still play, and with punch the old audio returns right at the punch-out.
- Cuts use the existing 3 ms micro-fades, so they don't click.
- Other tracks are untouched. Instrument tracks keep playing (MIDI recording merges into patterns).
- In Tracks and Deck, the covered range is veiled and labelled "Recording over — old audio muted", with the live take drawn on top.
- Afterwards the new take sits on top of the old clip (non-destructive "temp cover"). Undo, or deleting the take, brings the old audio back.

**Verified** with a fake microphone, listening to the master output:
- Normal recording: old audio −99 to −140 dB throughout, other track steady at −30 dB.
- Punch 3–5 s: old audio at −29 dB before 3 s, −142 dB inside the range, back to −29 dB at 5.3 s.
- Loop recording: silent across loop wraps.
- Regressions (loop-take mapping, sample-exact onsets, UI flow) pass.

## Windows and Ubuntu ports (2.3.1)

Both use the same Electron shell as the Mac app (`mac/app`), now platform-aware:
- `ffmpeg.exe` on Windows.
- The native menu bar is auto-hidden on Windows and Linux (Alt shows it).
- A single running instance: a second launch focuses the first.
- `--tuner` opens straight into the Tuner.
- A `.dawters` path given by the OS (or Finder's open-file) is opened as a song.

**Windows build** (`win/pack.js` → `win/installer.nsi` → makensis, all from Linux):
- `@electron/packager` win32-x64, with the icon and version info written by resedit (no Wine).
- A per-user NSIS installer with optional desktop and Tuner shortcuts, the `.dawters` → `DAWters.Song` association, and an uninstaller in Settings › Apps.
- A portable zip as well.

**Ubuntu build** (`linux/pack.js` → `linux/make_deb.sh`):
- A `.deb` installing to `/opt/dawters-and-son`, with `/usr/bin/dawters-and-son`.
- Two `.desktop` launchers (the studio's also has a *Tuner* action) and a shared-mime-info type (`*.dawters`, subclass of zip, weight 80).
- `postinst` makes chrome-sandbox setuid and loads an AppArmor `userns` profile when AppArmor 4 is present.

**Verified:**
- Windows: the installer was opened with 7-Zip and holds all 75 app files plus the uninstaller; the bundled studio is identical to the build and ffmpeg.exe is byte-identical; the exe has the icon group and version strings.
- Ubuntu: `apt install ./…deb` on Ubuntu 24.04 resolves dependencies, the desktop files validate, and gio reports `application/x-dawters` with the studio as default handler.
- Ubuntu: the installed app boots, opens a song passed on the command line, encodes MP3/Opus/FLAC with its ffmpeg, `--tuner` opens the solo Tuner, and WM_CLASS matches StartupWMClass.
- Electron shell (on Linux): a second launch with `--tuner` focuses the first window and opens its Tuner.
- **The Windows build has not been run on Windows.**

## v2.3.1 — Audition: hear any effect live

Every effect panel (Console inserts, the Deck FX sheet, the Tracks FX button and bus/master inserts) has an **Audition** strip at the top. Pick a source and press **▶ Listen**; the effect plays immediately and every knob is heard as you turn it. **Hear dry** compares against the unprocessed sound.
- **Sources:**
  - *This track's audio*: the clip at the playhead, looped dry, up to 8 s.
  - *The song from the playhead*: the real mix, with the effect in its real place.
  - Built-in test sounds: drum loop, snare hits (for hearing reverb and echo tails), voice (with sibilants for the de-esser), guitar chords, keys, bass line, full beat.
  - *Microphone (live)*: use headphones.
- **Sensible defaults:** the track's own audio when it has some; otherwise the sound that suits the effect (reverb/delay → snare hits, de-esser/doubler/opto → voice, compressors → drums, and so on). Buses and the master default to the song.
- **How it works:** a private copy of the effect runs on the test source, so nothing in the song changes and no recording or transport is needed. Gain-reduction meters follow the copy while it plays. Closing the panel stops the sound.
- **Wording:** the panel's footer button now says **Switch off / Switch on** (disable the effect in the mix), to tell it apart from **Hear dry**.
- **Verified:**
  - Every effect type auditions with signal.
  - On the snare test, the sound rings above −40 dB 33% of the time dry, 53% with a 2 s reverb, and 100% after turning Decay to 7 s mid-play.
  - Song mode restores the effect and stops the transport.
  - The mic source opens and closes the input.

## v2.3 — Master tab, Tuner, noise removal, studio effects

**Top-10 studio effects**, each a counterpart to one of the most-used plugin types. All are pure DSP in `src/fx-worklet.js` and verified by offline renders:

| # | Built-in | Comparable to | Verified |
|---|---|---|---|
| 1 | True-Peak Limiter: look-ahead, sliding-min + moving-average gain, 4× intersample detection, Transparent / Punchy / Aggressive | FabFilter Pro-L 2 | onset-exact; transient bursts ≤ −1.04 dBTP at a −1 ceiling (+1.68 without TP mode) |
| 2 | Multiband Compressor: 3 bands, Linkwitz-Riley with allpass alignment, per-band GR | Pro-MB, Waves C4 | sums flat to 0.00 dB |
| 3 | FET Compressor: input-driven, 4/8/12/20/All, colour | UA 1176 | |
| 4 | Opto Compressor: peak reduction, program-dependent release, tube | LA-2A, CL 1B | |
| 5 | Bus Compressor: 2/4/10, attack/release steps, auto release, sidechain HPF | SSL G-bus, Kotelnikov | |
| 6 | Saturator: Tape / Tube / Transformer / Console / Punish, 4× oversampled, auto gain | Decapitator, Saturn | even harmonics on Tube only; level held |
| 7 | Delay → Tape Echo: Digital / Tape / Analog, wow & flutter, saturating feedback | EchoBoy | loop-safe at 90% feedback |
| 8 | Tube EQ: low boost + atten trick, high boost with bandwidth, high atten, tube | Pultec EQP-1A | |
| 9 | De-esser: split (complementary band) or wideband, listen | Pro-DS | −10.6 dB on sibilant band, lows untouched |
| 10 | Doubler: two micro-pitch-shifted voices | MicroShift | |

Also new or improved:
- Reverb: Spring, Chamber and Ambience rooms, plus low cut and modulation.
- Transient Shaper.
- Stereo Imager (mono-bass, −62 dB of low side removed).
- 8 inserts per strip (was 4).
- The master strip's final limiter now uses the same exact-attack, true-peak design.

**Tracks view fix:** every track header now has an **FX** button with a count, and right-click offers **Effects…**. Before this, Tracks had no route to effects.

**Noise removal (done):** Edit › Noise removal…, or *Remove noise…* on a clip's menu.
- **Step 1, profile:** learned from a range you drag across pure noise. If nothing is selected, it uses the selected clip's quietest half-second.
- **Step 2:** Reduction, Sensitivity and Smoothing, then Preview (6 s) and Remove noise. *Keep only the noise* lets you check what gets taken out.
- **How it works:** STFT 2048 / hop 512. Each bin's gate decision uses the second-largest of five frames, Audacity-style, so stray noise peaks don't open it. Gains are smoothed in the dB domain and close over about 0.1 s.
- **Verified:** hiss −35.2 → −47.1 dB at 12 dB reduction, tone within 0.04 dB, exact pass-through, undoable.

**Master tab (done):**
- 16 recipes: 8 by genre (Pop & streaming, Hip-hop & trap, Rock & band, EDM & club, R&B & soul, Acoustic & folk, Jazz & classical, Lo-fi & chill) and 8 by approach (Transparent polish, Glue & cohesion, Loud & competitive, Warm analog, Wide & airy, Podcast & voice, Demo quick-master, Radio 1955). Each sets ordinary, editable master inserts plus target, ceiling and tape.
- A chain rack with every processor's knobs inline (bypass lamp, reorder, remove, add, live gain-reduction bars) and the final stage (Drive, Ceiling, Tape).
- VU, loudness readouts, and a short-term-vs-target bar.
- A spectrum analyser, mastered (solid) over unmastered (dotted).
- A level-matched A/B: the unmastered mix is played at the mastered loudness, from running RMS before and after the master.
- Analyse (offline report: integrated LUFS, true peak, peak-to-loudness, drive) and Match target.
- All 16 recipes render without NaN.

**Tuner (done):** a sub-product inside the studio. Open it with View › Tuner, **U**, Shift+Cmd+T on the Mac, the ♪ Tuner button on the Deck bar, `index.html#tuner`, or the separate **D&S Tuner** home-screen icon on Android (an activity alias).
- **Modes:** Chromatic, guitar (standard and drop D), bass 4 and 5, ukulele, violin, mandolin.
- **Display:** a huge note name, a cents needle with an in-tune window, "N cents low · tune up" in words, and Hz against the target.
- **Strings:** tap a string to lock to it and hear its reference tone.
- **Reference:** A4 adjustable from 415 to 466 Hz.
- **Accessibility:** keyboard control (←/→ strings, +/− A4, T tone, Esc) and a polite screen-reader announcement at most every 1.5 s.
- **How it works:** YIN pitch detection. Verified within 0.4 cents from E1 to E6, about 2 ms per reading, and correct on a live, slightly flat A2.

Other 2.3 changes:
- The top bar holds six tabs on one row from 1280 px up.
- Everything in 2.3 is plain DSP and measurement, with no AI.

## v2.2 — "On the Air": 1950s commercial redesign, mastering, bus bounces, compressed exports

**Design system: On the Air.** It's styled after a black-and-white 1950s coffee commercial, kept mostly ink-on-paper, with
the brutalist rule of one meaningful colour carried over (sponsor red `#C8231B`: record, clip lamp, selection,
the "on air" glow, the master value arcs).
- **Surfaces.** Warm newsprint paper (`#EFE8DA` / `#FBF8F1`) and warm ink (`#1A1611`).
- **Top bar.** A black "broadcast band" with a red pinstripe under it.
- **Texture.** A light film-grain and picture-tube vignette layer, which can be switched off in Settings.
- **Type.** *Yesteryear* script for title cards (dialog and sheet titles, the wordmark, track numbers, the master
  strip, empty states), *Oswald* condensed sign-painter capitals for controls and labels, and *Courier Prime*
  typewriter for numbers, readouts and notes.
- **Controls.**
  - Round bakelite knobs with a cream pointer and a red value arc; bipolar knobs arc from the centre.
  - Round appliance-style transport buttons; record pulses like an on-air lamp.
  - Pill toggles, and section switches that are red pilot lamps.
  - Chrome-capped faders.
- **Panels and canvases.**
  - Dialogs are framed title cards with a double rule; sheets have a script title and ornamental double-rule
    section heads.
  - Clips are rounded, with a round track-colour dot.
  - Loop, punch and mute regions use a printed halftone screen instead of hatching.
  - An ivory and ebony keyboard in the Pattern view.
  - A lit cream VU meter (0 VU = −14 dBFS RMS) on the master strip and in Mastering.
- **Colour.** Track colours are muted printer's inks; songs from earlier versions are mapped onto them.
- **Extras.** A one-second opening title card ("Stay tuned for… DAWters & Son — Good to the last take"), skipped
  under reduced motion, and a new on-air microphone icon.
- **Looks.** *Daytime* (paper) and *Late show* (dark).

**Mastering** (File › Mastering, Shift+M, or the red button on the master strip):
- Loudness targets: Streaming −14, Apple Music −16, CD/club −9, Podcast −16 and EBU R128 −23 LUFS, each with
  its true-peak ceiling.
- A **Drive** control pushes the master into the look-ahead limiter. It is live, saved with the song and
  applied in renders.
- Ceiling and Tape knobs.
- Five master-chain presets: Clean, Glue, Warm & wide, Punchy and Radio 1955. They write ordinary master inserts
  that you can edit afterwards.
- Live VU, momentary / short-term / integrated / true peak / LRA / limiter readouts, and a short-term-vs-target
  bar.
- **Match target** renders the song offline (2–4 passes) and sets the drive that lands on the target. If the
  measured 4× true peak runs over, it also lowers the ceiling.

**Export** (File › Export):
- What: stereo mix, stems (every track), **bus stems** (each mixbus, everything feeding it through the bus
  strip), or everything at once in one zip.
- Loudness: as mixed, **mastered to the target** (same fitting as Match, without changing the song), or
  peak-normalised.
- Formats: WAV 16 (dithered) / 24 / 32-float, plus **ffmpeg** encodes: FLAC; MP3 320/256/192/128; AAC .m4a
  256/160; Ogg Vorbis ~192; Opus 128/64.
  - The file size is estimated before you export.
  - Compressed files get title, artist and comment tags.
  - The report gives integrated LUFS and true peak.
- Where the encoding happens:
  - **Mac:** a static native ffmpeg in `Contents/Resources/ffmpeg` (libmp3lame, libopus, libvorbis, AAC, FLAC).
  - **Android and the web version:** ffmpeg.wasm in a worker, loaded from the app's own `ff/` folder on the
    first compressed export. The page fetches the files and hands them over, so the worker never needs the
    network. In this build Opus uses ffmpeg's own Opus encoder.

**Bounce**: the Bounce dialog now offers mixbuses as well as tracks.
- A bus bounce prints everything feeding that bus through the bus strip and inserts, as "Mixbus N print".
- *Mute* or *Delete originals* also mutes the bus. All of it is undoable.

## v2.1 — Project5 layer, core effects

- **Instrument tracks:**
  - Synth: polyBLEP oscillators, multimode filter, envelopes, LFO, glide, mono/poly, 14 presets.
  - Drum synth: 8 pads, per-pad samples, 4 kits.
  - Sampler.
- **Pattern editor:** piano roll and step grid, velocity lane, quantize and transpose, an on-screen keyboard and
  drum pads, and a computer-keyboard piano.
- **Pattern clips** loop on the timeline.
- **GrooveMatrix:** launch patterns per track and per scene, quantised to the bar, and record launches into the
  arrangement.
- **MIDI input:** Web MIDI on Mac and web (Android WebView has no Web MIDI, so on-screen keys only there).
  Recording into patterns, with sustain.
- **Core effects:** Compressor, Limiter, Gate, Distortion (overdrive / fuzz / rectify / bitcrush), Parametric
  EQ, Filter with LFO, and Stereo width, alongside Reverb, Delay, Chorus, Phaser, Tremolo, Tube Drive and Graphic
  EQ.
- **Inserts on mixbuses and the master.**
- **Zoom** centres on the playhead.

## v2.0 — renamed DAWters and Son, brutalist redesign (look superseded by 2.2)

The app is now **DAWters and Son**. Bundle ID `com.wilk.dawters` and the Android package are unchanged,
so 2.0 installs over earlier builds and keeps the autosaved song (the Mac app keeps reading its
existing "DAWters and Suns" data folder). On the Mac the app now appears as "DAWters and Son.app";
the old "DAWters and Suns.app" can be deleted. New exports default to `Music/DAWters and Son/`.

**Design system** — brutalist: black on white (or fully inverted), 2 px rules and 3 px structural rules,
square corners everywhere, no gradients, blur or soft shadows (only hard offset shadows on floating
menus and dialogs), one signal red (`#FF2B00`) reserved for record, clipping, selection, punch and
markers. Type is IBM Plex Mono throughout, uppercase labels, with Archivo Black for the wordmark,
headings and track numbers. Knobs are square level boxes (fill height = value; bipolar knobs fill
from a red centre line); faders and caps are plain black blocks; meters are solid black with the top
3 dB in red; loop and punch regions are hatched. Track colours appear only as small identifying
blocks. Buttons in a group butt together sharing one rule. The logo is four tracks in a black block,
one of them red. Effects have plain names (Reverb, Delay, Chorus / Flanger, Phaser, Tremolo,
Tube Drive, Graphic EQ — 10 band). Themes: Light and Inverted.

## Iteration 2 (v1.1) — Deck

**Deck view** — a one-screen, big-control, touch-first view inspired by pocket multitrack apps
(J4T), with no track limit: every track is a row with record-arm, mute, solo, FX, a waveform lane,
a horizontal volume slider with meter, and pan. Phones and touch devices open in Deck; Tracks and
Console are one tab away. On wide screens (≥1000 px) the selected track's full channel strip sits
alongside the rows. A big bottom transport bar (home, stop, play, record, Quick idea, time, loop,
click, follow, zoom, bounce, add track, undo) replaces the top-bar transport in Deck.

**Swipes** — swipe a track row right for its Setup sheet (name, colour, input, arm, input
monitoring, output routing, mono/stereo, envelopes, channel strip, bounce, duplicate, move,
delete); swipe left for its Effects sheet. The row slides with the finger and shows which sheet is
coming. Tapping the track name also opens Setup. The waveform lane keeps its own gestures.

**Gestures (Deck and Tracks)** — one finger on a clip moves it (trim grips appear once selected),
one finger on empty space scrolls, tap moves the playhead, two fingers pinch-zoom, long-press opens
an action sheet. The old Scroll/Edit switch is gone. On touch screens menus open as bottom sheets.

**Bounce** — pick tracks and mix them down to one new stereo track through their strips, inserts and
mixbus sends (master left out), silence trimmed, placed at the right time; mute, delete or keep the
originals. Bounce output matches the live mix to −141 dB.

**Quick idea** — one tap (or Q) arms the first empty track, adding a track if all are used, and records.

**First run on phones/tablets** — offers the speaker-and-mic latency calibration.

## Build

```
python3 build.py        # → dist/dawters.html (single self-contained file)
./build-all.sh          # → web zip, Mac DMG, Android APK in dist/
```

Before the Mac build, put the static ffmpeg in place (it is not in the source zip):
`npm pack @ffmpeg-installer/darwin-arm64@4.1.5 && tar xzf ffmpeg-installer-darwin-arm64-4.1.5.tgz && mkdir -p mac/ffmpeg && cp package/ffmpeg mac/ffmpeg/`.
The ffmpeg.wasm core lives in `vendor/ffmpeg-wasm/` (from `@ffmpeg/core@0.12.10`, `dist/umd`).

Mac build from Linux: `@electron/packager` (darwin/arm64) → `rcodesign sign` (ad-hoc) →
`tools/make_dmg.py` (HFS+ via libdmg-hfsplus, preserves framework symlinks). On a Mac you can
replace the last two steps with `codesign --force --deep -s -` and `hdiutil create`.

Android (versionCode 9): `android/build-apk.sh` (aapt → javac → dx → zipalign → apksigner), package
`com.wilk.dawters`, minSdk 24, targetSdk 28, no INTERNET permission. Release builds are signed with the
maintainer's key, passed in as `DAWTERS_KEYSTORE` (path) and `DAWTERS_KS_PASS`; the key is never in the
repository. Without them the script signs with a throwaway development key, which is fine for testing but
won't install over a release build.

## Layout

- `src/worklet.js` — `ds-channel` (strip/bus/master DSP, limiter, loudness), `ds-fader`, `ds-rec`
- `src/engine.js` — mixer graph (live + offline), transport and look-ahead scheduler, recording, render
- `src/model.js` — project model, clip flattening, undo history
- `src/fx.js` — insert effect registry
- `src/kit.js` — knobs, faders, meters, menus, dialogs
- `src/arrange.js` — tracks view (canvas timeline, ruler, editing)
- `src/console.js` — console view
- `src/app.js` — controller, file I/O, export, settings, shortcuts
- `src/inst-worklet.js`, `src/instruments.js` — `ds-inst` synth / drums / sampler and presets
- `src/pattern.js`, `src/matrix.js` — pattern editor + instrument panel, GrooveMatrix
- `src/master.js` — mastering panel, loudness fitting, 4× true peak, master-chain presets
- `src/fx-worklet.js` — studio effect processors (character compressors, multiband, de-esser, transient shaper, saturator, true-peak limiter, doubler, imager)
- `src/audition.js` — live effect audition (test sounds, track audio, song, mic)
- `src/denoise.js` — noise profile + spectral noise removal; `src/tuner.js` — the Tuner
- `src/encode.js`, `src/ff/ffmpeg-worker.js` — export formats; native ffmpeg (Mac) or ffmpeg.wasm (`vendor/ffmpeg-wasm/`, copied to `dist/ff/`)
- `src/style.css` — "On the Air" design system (fonts: Yesteryear, Oswald, Courier Prime — SIL OFL 1.1)
- `mac/ffmpeg/ffmpeg` — static arm64 ffmpeg for the Mac app (from `@ffmpeg-installer/darwin-arm64`)
- `win/` — Windows packaging (packager script, NSIS installer, ffmpeg.exe); `linux/` — Ubuntu .deb packaging
- `mac/app/` — Electron main + preload (shared by Mac, Windows, Linux); `android/` — WebView shell; `web/` — localhost launcher

## Verified (headless Chromium + Linux Electron)

Clip onset sample-exact in renders (limiter look-ahead compensated); mono pan law −3 dB centre /
hard-left 0 dB; fader −6 dB + clip +6 dB → unity; compressor within 0.4 dB of the static curve;
limiter holds −1.0 dBFS with +12 dB drive; occluded clip region silent, resumes after; volume
envelope midpoint correct; loop-record 2 s loop × 2.1 passes → two full takes + 0.15 s tail at the
right buffer offsets; fake-mic recording end to end; import, drag across tracks, undo, duplicate,
range select, inserts, export WAV, save `.dawters`, autosave restore, reopen; Android save bridge
byte-identical; file:// and localhost both run; Electron shell menus, IPC and mic path work.
Deck: 10–11 tracks at tablet landscape/portrait and phone sizes (rows scroll), swipe right/left open Setup/Effects, waveform drag does not trigger swipes, buttons still tap, bounce exact, quick idea records on a new 11th track, touch tap/long-press/pinch on Tracks.
2.2:
- Loudness fitting lands on −14.00, −9.00 and −23.00 LUFS for the respective targets.
- Bus stems isolate exactly. The other bus and direct tracks come in below −100 dB, after fixing a race where
  offline bus mutes arrived late.
- A bus bounce contains only that bus's sources.
- ffmpeg.wasm encodes MP3, AAC, Ogg, Opus and FLAC in Chromium, and the MP3 decodes back correctly.
- Native ffmpeg encodes from the Electron shell (tested with the Linux build of the same package).
- The "everything" export produces a 6-file zip mastered to −14.0 LUFS.
- Top bar on one row from 1280 to 1920 px.
- Daytime and Late-show screenshots of every view.

**Not yet run on a physical Mac or Android device.**

## Later phases (to be decided)

Audacity-grade destructive editor, multiband / mid-side mastering tools and reference-track matching,
MIDI on Android (USB MIDI through a native bridge), plugins (Web Audio Modules; native VST3/AU host
for the Mac build only).
