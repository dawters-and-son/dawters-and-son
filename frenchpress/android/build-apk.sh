#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. France's French Press, part of the DAWters and Son suite; see LICENSE (no warranty).
# Build France's French Press for Android offline with Debian/Ubuntu SDK packages:
#   apt install aapt apksigner zipalign dalvik-exchange libandroid-23-java default-jdk
set -e
cd "$(dirname "$0")"
SDK=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
DX=$(command -v dx || command -v dalvik-exchange)
V=$(sed -n "s/^V = '\(.*\)'/\1/p" ../build.py)
(cd .. && python3 build.py >/dev/null)
rm -rf build assets && mkdir -p build/gen build/classes build/apk assets
cp ../dist/frenchpress.html assets/index.html
aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$SDK" --min-sdk-version 24 --target-sdk-version 28
unset JAVA_TOOL_OPTIONS
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$SDK" -d build/classes build/gen/com/wilk/frenchpress/R.java src/com/wilk/frenchpress/MainActivity.java
$DX --dex --min-sdk-version=24 --output=build/apk/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK" --min-sdk-version 24 --target-sdk-version 28 -F build/unsigned.apk
(cd build/apk && aapt add ../unsigned.apk classes.dex >/dev/null)
zipalign -f 4 build/unsigned.apk build/aligned.apk
# Release key: FRENCHPRESS_KEYSTORE (default tools/frenchpress.keystore) + FRENCHPRESS_KS_PASS (+ FRENCHPRESS_KS_ALIAS, default
# "frenchpress"). None of it belongs in the repository. The suite release build passes the DAWters key (alias "dawters").
# Without them the APK is signed with a throwaway development key (fine for testing; it won't update a release install).
KS=${FRENCHPRESS_KEYSTORE:-tools/frenchpress.keystore}; PASS=${FRENCHPRESS_KS_PASS:-}; ALIAS=${FRENCHPRESS_KS_ALIAS:-frenchpress}
if [ ! -f "$KS" ] || [ -z "$PASS" ]; then
  echo "No release key (set FRENCHPRESS_KEYSTORE and FRENCHPRESS_KS_PASS) - signing with a development key."
  KS=build/dev.keystore; PASS=android; ALIAS=frenchpress
  keytool -genkeypair -keystore "$KS" -alias frenchpress -keyalg RSA -keysize 2048 -validity 12000 -storepass $PASS -keypass $PASS -dname "CN=France's French Press development" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-key-alias "$ALIAS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out "build/French-Press-$V.apk" build/aligned.apk
apksigner verify --print-certs "build/French-Press-$V.apk" | head -2
ls -la "build/French-Press-$V.apk"
