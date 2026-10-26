#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# Build every DAWters and Son package into dist/.
#   web:     python3 only
#   mac:     node + npm (Electron is downloaded once), rcodesign (cargo install apple-codesign),
#            libdmg-hfsplus "hfsplus" + "dmg" tools, hfsprogs (mkfs.hfsplus). On a Mac you can instead run
#            mac/pack.js and then: codesign --force --deep -s - "mac/out/.../DAWters and Son.app" && hdiutil create ...
#   android: see android/build-apk.sh (and increaser/android/build-apk.sh)
#   linux:   dpkg-deb; Electron for linux is downloaded once
#   windows: makensis (apt install nsis); Electron for win32 is downloaded once; ffmpeg.exe from @ffmpeg-installer/win32-x64
set -e
cd "$(dirname "$0")"
V=2.4.0
python3 build.py
cp LICENSE web/LICENSE.txt; cp LICENSE mac/app/LICENSE; cp LICENSE build/LICENSE.txt
cp dist/dawters.html web/index.html
mkdir -p web/ff && cp dist/ff/ffmpeg-core.js dist/ff/ffmpeg-core.wasm dist/ff/THIRD-PARTY.txt web/ff/
python3 tools/make_web_zip.py web "dist/DAWters-and-Son-$V-web.zip"
if [ "$SKIP_MAC" != 1 ]; then
  cp dist/dawters.html mac/app/dawters.html; cp vendor/THIRD-PARTY.txt mac/app/THIRD-PARTY.txt
  (cd mac && [ -d node_modules/@electron/packager ] || npm i -D @electron/packager@20 electron@45.0.0 --ignore-scripts)
  node mac/pack.js
  APP="mac/out/DAWters and Son-darwin-arm64/DAWters and Son.app"
  ${RCODESIGN:-rcodesign} sign "$APP" >/dev/null
  rm -f "dist/DAWters-and-Son-$V-arm64.dmg"
  python3 tools/make_dmg.py "$APP" "dist/DAWters-and-Son-$V-arm64.dmg" "DAWters and Son" "build/Read Me First.txt" build/LICENSE.txt
fi
if [ "$SKIP_WIN" != 1 ]; then
  # Windows x64: same Electron shell; needs mac/node_modules (above), win/ffmpeg/ffmpeg.exe and makensis (apt install nsis)
  cp dist/dawters.html mac/app/dawters.html; cp vendor/THIRD-PARTY.txt mac/app/THIRD-PARTY.txt
  node win/pack.js
  cp LICENSE "win/out/DAWters and Son-win32-x64/LICENSE-DAWters-and-Son.txt"
  (cd win && makensis -V2 -DVERSION=$V "-DOUTFILE=../dist/DAWters-and-Son-$V-Setup-x64.exe" installer.nsi)
  rm -f "dist/DAWters-and-Son-$V-win-x64-portable.zip"
  (cd win/out && zip -qr -9 "../../dist/DAWters-and-Son-$V-win-x64-portable.zip" "DAWters and Son-win32-x64")
fi
if [ "$SKIP_LINUX" != 1 ]; then
  # Ubuntu / Debian (amd64): needs dpkg-deb; linux/ffmpeg/ffmpeg from @ffmpeg-installer/linux-x64
  cp dist/dawters.html mac/app/dawters.html; cp vendor/THIRD-PARTY.txt mac/app/THIRD-PARTY.txt
  node linux/pack.js
  cp LICENSE "linux/out/DAWters and Son-linux-x64/LICENSE-DAWters-and-Son.txt"
  sh linux/make_deb.sh $V
fi
if [ "$SKIP_ANDROID" != 1 ]; then
  sh android/build-apk.sh
  cp android/build/DAWters-and-Son.apk "dist/DAWters-and-Son-$V.apk"
fi
# The Increaser (the suite's live looper) ships with each release: its web zip always, its APK with the same
# release key as DAWters (INCREASER_KEYSTORE / INCREASER_KS_PASS default to the DAWters ones).
IV=$(sed -n "s/^V = '\(.*\)'/\1/p" increaser/build.py)
(cd increaser && python3 build.py >/dev/null) && cp "increaser/dist/The-Increaser-$IV-web.zip" dist/
if [ "$SKIP_ANDROID" != 1 ]; then
  if [ -z "$INCREASER_KEYSTORE" ] && [ -n "$DAWTERS_KEYSTORE" ]; then INCREASER_KEYSTORE=$DAWTERS_KEYSTORE; INCREASER_KS_PASS=$DAWTERS_KS_PASS; INCREASER_KS_ALIAS=dawters; fi
  INCREASER_KEYSTORE=$INCREASER_KEYSTORE INCREASER_KS_PASS=$INCREASER_KS_PASS INCREASER_KS_ALIAS=${INCREASER_KS_ALIAS:-increaser} sh increaser/android/build-apk.sh
  cp "increaser/android/build/The-Increaser-$IV.apk" dist/
fi
ls -la dist
