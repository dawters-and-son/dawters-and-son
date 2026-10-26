#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# Build Eleosynth and Esperanza's Drum Kit from their repositories and copy their single-file pages into
# vendor/suite/, where build.py picks them up as plugins. (The Increaser, the suite's live looper, lives in
# increaser/ in this repository; tools/assemble_site.sh builds it and publishes it at /increaser/.)
#   ELEO_DIR  path to a checkout of github.com/Eleosynth/Eleosynth            (default ../eleosynth)
#   EDK_DIR   path to a checkout of github.com/Esperanza-s-Drum-Kit/...       (default ../esperanza-s-drum-kit)
set -e
cd "$(dirname "$0")/.."
ELEO_DIR=${ELEO_DIR:-../eleosynth}; EDK_DIR=${EDK_DIR:-../esperanza-s-drum-kit}
mkdir -p vendor/suite
(cd "$ELEO_DIR" && python3 build.py >/dev/null) && cp "$ELEO_DIR/dist/eleosynth.html" vendor/suite/eleosynth.html
(cd "$EDK_DIR" && python3 build.py >/dev/null) && cp "$EDK_DIR/dist/edk.html" vendor/suite/edk.html
{ echo "Eleosynth $(git -C "$ELEO_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"; echo "Esperanza's Drum Kit $(git -C "$EDK_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"; } > vendor/suite/VERSIONS.txt
ls -la vendor/suite
