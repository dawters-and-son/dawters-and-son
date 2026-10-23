#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# Build DAWters and Son for Android offline with Debian/Ubuntu SDK packages:
#   apt install aapt apksigner zipalign dalvik-exchange android-sdk-platform-23 default-jdk
set -e
cd "$(dirname "$0")"
SDK=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
DX=$(command -v dx || command -v dalvik-exchange)
rm -rf build && mkdir -p build/gen build/classes build/apk
cp ../dist/dawters.html assets/index.html
mkdir -p assets/ff && cp ../dist/ff/ffmpeg-core.js ../dist/ff/ffmpeg-core.wasm ../dist/ff/THIRD-PARTY.txt assets/ff/
aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$SDK" --min-sdk-version 24 --target-sdk-version 28
unset JAVA_TOOL_OPTIONS
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$SDK" -d build/classes build/gen/com/wilk/dawters/R.java src/com/wilk/dawters/MainActivity.java
$DX --dex --min-sdk-version=24 --output=build/apk/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK" --min-sdk-version 24 --target-sdk-version 28 -F build/unsigned.apk
(cd build/apk && aapt add ../unsigned.apk classes.dex >/dev/null)
zipalign -f 4 build/unsigned.apk build/aligned.apk
# Release key: DAWTERS_KEYSTORE (default tools/dawters.keystore) + DAWTERS_KS_PASS. Neither belongs in the repository.
# Without them the APK is signed with a throwaway development key (fine for testing; it won't update a release install).
KS=${DAWTERS_KEYSTORE:-tools/dawters.keystore}; PASS=${DAWTERS_KS_PASS:-}
if [ ! -f "$KS" ] || [ -z "$PASS" ]; then
  echo "No release key (set DAWTERS_KEYSTORE and DAWTERS_KS_PASS) - signing with a development key."
  KS=build/dev.keystore; PASS=android
  keytool -genkeypair -keystore "$KS" -alias dawters -keyalg RSA -keysize 2048 -validity 12000 -storepass $PASS -keypass $PASS -dname "CN=DAWters and Son development" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-key-alias dawters --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out build/DAWters-and-Son.apk build/aligned.apk
apksigner verify --print-certs build/DAWters-and-Son.apk | head -2
ls -la build/DAWters-and-Son.apk
