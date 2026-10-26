// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — Linux x64 build (the same Electron shell as the Mac and Windows apps)
const path = require('path');
const { packager } = require(require.resolve('@electron/packager', { paths: [path.join(__dirname, '..', 'mac')] }));
const V = require(path.join(__dirname, '..', 'mac', 'app', 'package.json')).version;
(async () => {
  const out = await packager({
    dir: path.join(__dirname, '..', 'mac', 'app'), out: path.join(__dirname, 'out'), overwrite: true,
    platform: 'linux', arch: 'x64', electronVersion: '45.0.0',
    name: 'DAWters and Son', executableName: 'dawters-and-son', appVersion: V, buildVersion: V, asar: true, prune: false,
    extraResource: [path.join(__dirname, 'ffmpeg', 'ffmpeg'), ...(require('fs').existsSync(path.join(__dirname, 'plughost')) ? [path.join(__dirname, 'plughost')] : [])],
  });
  console.log(out);
})().catch((e) => { console.error(e); process.exit(1); });
