DAWters and Son 2.3.4 — lightweight web version

Double-click the starter for your computer:
  Mac:      "Start DAWters (Mac).command"   (first time: right-click > Open)
  Windows:  "Start DAWters (Windows).bat"
  Linux:    ./start.sh
It starts a tiny local server (http://localhost:8737) and opens the studio in
your browser. Use Chrome or Edge for the best audio. Keep the little window open
while you work.

Keep the "ff" folder next to index.html: it holds the ffmpeg encoder used for
MP3, AAC, Ogg, Opus and FLAC exports. It loads the first time you export a
compressed file.

The tuner on its own: add #tuner to the address (http://localhost:8737/#tuner).

No Python? Open index.html directly in Chrome. Everything works except
compressed exports (WAV still works), and some browsers ask for microphone
permission each time.

Your current song autosaves in the browser. Use File > Save song to keep a
.dawters file with all its audio, and File > Export for mixes, stems and bus
stems, mastered to a loudness target if you like.

LICENSE
DAWters and Son is free software: no price, no tiers, no sign-up, no tracking.
Copyright (C) 2026 Josh Wilk. You may use, share and change it under the
GNU General Public License, version 3 or (at your option) any later version.
It comes with ABSOLUTELY NO WARRANTY. The full license is in LICENSE.txt
(also under Help > About > License in the app). Source code:
https://github.com/dawters-and-son/dawters-and-son
