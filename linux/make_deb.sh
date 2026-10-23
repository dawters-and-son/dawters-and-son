#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# Build dist/DAWters-and-Son-<V>-amd64.deb from linux/out (run linux/pack.js first). Needs dpkg-deb.
set -e
cd "$(dirname "$0")/.."
V=${1:-$(node -p "require('./mac/app/package.json').version")}
SRC="linux/out/DAWters and Son-linux-x64"
R=linux/deb-root
rm -rf "$R"; mkdir -p "$R/DEBIAN" "$R/opt" "$R/usr/bin" "$R/usr/share/applications" "$R/usr/share/mime/packages" "$R/etc/apparmor.d" "$R/usr/share/doc/dawters-and-son"
cp -a "$SRC" "$R/opt/dawters-and-son"
chmod -R u=rwX,go=rX "$R/opt/dawters-and-son"; chmod 755 "$R/opt/dawters-and-son/dawters-and-son" "$R/opt/dawters-and-son/resources/ffmpeg" "$R/opt/dawters-and-son/chrome_crashpad_handler"
ln -s /opt/dawters-and-son/dawters-and-son "$R/usr/bin/dawters-and-son"
for s in 16 32 48 64 128 256 512; do
  d="$R/usr/share/icons/hicolor/${s}x${s}/apps"; mkdir -p "$d"
  cp build/icons/icon-$s.png "$d/dawters-and-son.png"
  [ -f build/icons/tuner-$s.png ] && cp build/icons/tuner-$s.png "$d/dawters-and-son-tuner.png" || cp build/icons/tuner-256.png "$d/dawters-and-son-tuner.png"
done
mkdir -p "$R/usr/share/icons/hicolor/scalable/apps" "$R/usr/share/icons/hicolor/scalable/mimetypes"
cp src/icon.svg "$R/usr/share/icons/hicolor/scalable/apps/dawters-and-son.svg"
cp src/tuner-icon.svg "$R/usr/share/icons/hicolor/scalable/apps/dawters-and-son-tuner.svg"
cp src/icon.svg "$R/usr/share/icons/hicolor/scalable/mimetypes/application-x-dawters.svg"
cat > "$R/usr/share/applications/dawters-and-son.desktop" <<D
[Desktop Entry]
Type=Application
Name=DAWters and Son
GenericName=Multitrack Studio
Comment=Record, mix, master — instruments, GrooveMatrix, console and tuner
Exec=/opt/dawters-and-son/dawters-and-son %F
Icon=dawters-and-son
Terminal=false
Categories=AudioVideo;Audio;Recorder;Sequencer;Music;
Keywords=DAW;record;mix;master;multitrack;midi;
MimeType=application/x-dawters;
StartupWMClass=dawters-and-son
Actions=tuner;

[Desktop Action tuner]
Name=Tuner
Exec=/opt/dawters-and-son/dawters-and-son --tuner
D
cat > "$R/usr/share/applications/dawters-and-son-tuner.desktop" <<D
[Desktop Entry]
Type=Application
Name=D&S Tuner
GenericName=Instrument Tuner
Comment=Chromatic, guitar, bass, ukulele and violin tuner from DAWters and Son
Exec=/opt/dawters-and-son/dawters-and-son --tuner
Icon=dawters-and-son-tuner
Terminal=false
Categories=AudioVideo;Audio;Music;
Keywords=tuner;guitar;bass;pitch;
StartupWMClass=dawters-and-son
D
cat > "$R/usr/share/mime/packages/dawters-and-son.xml" <<D
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-dawters">
    <comment>DAWters and Son song</comment>
    <sub-class-of type="application/zip"/>
    <icon name="application-x-dawters"/>
    <glob pattern="*.dawters" weight="80"/>
  </mime-type>
</mime-info>
D
# Ubuntu 23.10+ restricts unprivileged user namespaces; like Chrome and VS Code, allow them for this app only
cat > "$R/etc/apparmor.d/dawters-and-son" <<D
abi <abi/4.0>,
include <tunables/global>

profile dawters-and-son /opt/dawters-and-son/dawters-and-son flags=(unconfined) {
  userns,
  include if exists <local/dawters-and-son>
}
D
cp vendor/THIRD-PARTY.txt "$R/usr/share/doc/dawters-and-son/THIRD-PARTY.txt"
{ cat <<D
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: DAWters and Son
Upstream-Contact: Josh Wilk
Source: https://github.com/dawters-and-son/dawters-and-son

Files: *
Copyright: 2026 Josh Wilk
License: GPL-3.0+

Files: opt/dawters-and-son/resources/ffmpeg
Copyright: the FFmpeg developers
License: GPL-2.0+
 See /usr/share/doc/dawters-and-son/THIRD-PARTY.txt.

Files: opt/dawters-and-son/*.so opt/dawters-and-son/*.pak opt/dawters-and-son/dawters-and-son opt/dawters-and-son/LICENSE*
Copyright: GitHub Inc., the Electron and Chromium authors
License: MIT and others
 See /opt/dawters-and-son/LICENSE and /opt/dawters-and-son/LICENSES.chromium.html.

License: GPL-3.0+
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 .
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.
 .
 On Debian systems, the complete text of the GNU General Public
 License version 3 can be found in "/usr/share/common-licenses/GPL-3".
D
} > "$R/usr/share/doc/dawters-and-son/copyright"
SIZE=$(du -sk "$R" | cut -f1)
cat > "$R/DEBIAN/control" <<D
Package: dawters-and-son
Version: $V
Section: sound
Priority: optional
Architecture: amd64
Installed-Size: $SIZE
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxss1, libxtst6, libatspi2.0-0t64 | libatspi2.0-0, libdrm2, libsecret-1-0, xdg-utils
Recommends: pulseaudio | pipewire-pulse
Maintainer: Josh Wilk <noreply@dawters.invalid>
Homepage: https://github.com/dawters-and-son/dawters-and-son
Description: Multitrack recording studio with console, instruments and mastering
 DAWters and Son records and mixes any number of tracks through a
 knob-per-function console with mixbuses, and adds synths, drums,
 a sampler, a piano roll, a GrooveMatrix, MIDI, mastering recipes with
 loudness targets, noise removal, a tuner and MP3/AAC/Ogg/Opus/FLAC export.
D
cat > "$R/DEBIAN/conffiles" <<D
/etc/apparmor.d/dawters-and-son
D
cat > "$R/DEBIAN/postinst" <<'D'
#!/bin/sh
set -e
# Electron's setuid sandbox helper
chown root:root /opt/dawters-and-son/chrome-sandbox 2>/dev/null || true
chmod 4755 /opt/dawters-and-son/chrome-sandbox 2>/dev/null || true
if [ -x /usr/sbin/apparmor_parser ] && [ -e /etc/apparmor.d/abi/4.0 ] && aa-enabled --quiet 2>/dev/null; then
  apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/dawters-and-son 2>/dev/null || true
fi
command -v update-mime-database >/dev/null && update-mime-database /usr/share/mime >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
D
cat > "$R/DEBIAN/postrm" <<'D'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  [ -x /usr/sbin/apparmor_parser ] && apparmor_parser --remove /etc/apparmor.d/dawters-and-son 2>/dev/null || true
  command -v update-mime-database >/dev/null && update-mime-database /usr/share/mime >/dev/null 2>&1 || true
  command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
D
chmod 755 "$R/DEBIAN/postinst" "$R/DEBIAN/postrm"
OUT="dist/DAWters-and-Son-$V-amd64.deb"
dpkg-deb --root-owner-group -Zxz --build "$R" "$OUT" >/dev/null
rm -rf "$R"
ls -la "$OUT"
