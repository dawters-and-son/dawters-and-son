// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — Windows build (x64; also runs on Windows on ARM through emulation).
// Uses the same Electron shell as the Mac app (mac/app). Icon and version info are written with resedit, so no Wine is needed.
const path = require('path');
const { packager } = require(require.resolve('@electron/packager', { paths: [path.join(__dirname, '..', 'mac')] }));
const V = require(path.join(__dirname, '..', 'mac', 'app', 'package.json')).version;
(async () => {
  const out = await packager({
    dir: path.join(__dirname, '..', 'mac', 'app'), out: path.join(__dirname, 'out'), overwrite: true,
    platform: 'win32', arch: 'x64', electronVersion: '45.0.0',
    name: 'DAWters and Son', executableName: 'DAWters and Son', appVersion: V, buildVersion: V,
    icon: path.join(__dirname, '..', 'build', 'icons', 'dawters.ico'), asar: true, prune: false,
    appCopyright: 'Copyright © 2026 Josh Wilk. Free software under the GNU GPL v3 or later.',
    extraResource: [path.join(__dirname, 'ffmpeg', 'ffmpeg.exe'), path.join(__dirname, '..', 'build', 'icons', 'tuner.ico')],
    win32metadata: { CompanyName: 'DAWters and Son', ProductName: 'DAWters and Son', FileDescription: 'DAWters and Son — multitrack studio', OriginalFilename: 'DAWters and Son.exe', InternalName: 'DAWters and Son' },
  });
  console.log(out);
})().catch((e) => { console.error(e); process.exit(1); });
