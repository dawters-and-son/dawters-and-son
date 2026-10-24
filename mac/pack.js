// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
const { packager } = require('@electron/packager');
(async () => {
  const out = await packager({
    dir: __dirname + '/app', out: __dirname + '/out', overwrite: true,
    platform: 'darwin', arch: 'arm64', electronVersion: '45.0.0',
    name: 'DAWters and Son', executableName: 'DAWters and Son', appBundleId: 'com.wilk.dawters', appCategoryType: 'public.app-category.music',
    appVersion: '2.4.0', buildVersion: '12', icon: __dirname + '/../build/icons/dawters.icns', asar: true, prune: false, osxSign: false,
    extraResource: [__dirname + '/ffmpeg/ffmpeg'],
    appCopyright: 'Copyright © 2026 Josh Wilk. Free software under the GNU GPL v3 or later.',
    extendInfo: { NSMicrophoneUsageDescription: 'DAWters and Son records audio from your microphone or audio interface.', LSMinimumSystemVersion: '12.0', NSHighResolutionCapable: true },
  });
  console.log(out);
})().catch((e) => { console.error(e); process.exit(1); });
