#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# Assemble the public website into _site/: the marketing page at / and the web app at /app/.
set -e
cd "$(dirname "$0")/.."
python3 build.py
rm -rf _site && mkdir -p _site/app/ff
cp -r site/. _site/
cp dist/dawters.html _site/app/index.html
cp dist/ff/ffmpeg-core.js dist/ff/ffmpeg-core.wasm dist/ff/THIRD-PARTY.txt _site/app/ff/
cp LICENSE _site/LICENSE.txt
touch _site/.nojekyll
du -sh _site
