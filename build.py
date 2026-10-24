#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
"""Build DAWters and Son into one self-contained HTML file: dist/dawters.html"""
import base64, json, os, re
ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE_URL = 'https://github.com/dawters-and-son/dawters-and-son'  # change if the repository lives elsewhere
S = lambda p: open(os.path.join(ROOT, 'src', p), encoding='utf-8').read()
css = S('style.css')
def font(m):
    data = open(os.path.join(ROOT, 'src', 'fonts', m.group(1) + '.woff2'), 'rb').read()
    return 'url(data:font/woff2;base64,' + base64.b64encode(data).decode() + ')'
css = re.sub(r'url\(FONT:([\w-]+)\)', font, css)
worklet = S('worklet.js') + '\n' + S('inst-worklet.js') + '\n' + S('fx-worklet.js')
js = '"use strict";\nconst WORKLET_SRC = ' + json.dumps(worklet) + ';\nconst FFW_SRC = ' + json.dumps(S('ff/ffmpeg-worker.js')) + ';\n' + 'const LICENSE_TXT = ' + json.dumps(open(os.path.join(ROOT, 'LICENSE'), encoding='utf-8').read()) + ';\nconst SOURCE_URL = ' + json.dumps(SOURCE_URL) + ';\n' + '\n'.join(S(f) for f in ['util.js', 'instruments.js', 'model.js', 'fx.js', 'suite.js', 'engine.js', 'kit.js', 'arrange.js', 'console.js', 'deck.js', 'pattern.js', 'matrix.js', 'encode.js', 'master.js', 'denoise.js', 'tuner.js', 'audition.js', 'app.js'])
js = js.replace("'use strict';", '')
icon = 'data:image/svg+xml;base64,' + base64.b64encode(open(os.path.join(ROOT, 'src', 'icon.svg'), 'rb').read()).decode()
html = S('index.html').replace('/*CSS*/', css).replace('/*JS*/', js.replace('</script', '<\\/script')).replace('ICON_DATAURL', icon)
# the suite: Eleosynth and Esperanza's Drum Kit, built by their own repositories (tools/update_suite.sh) and
# carried here gzip-compressed + base64 so DAWters can open them as plugins with no network and no extra files
import gzip
suite = ''
for kind, fn in [('eleo', 'eleosynth.html'), ('edk', 'edk.html')]:
    pth = os.path.join(ROOT, 'vendor', 'suite', fn)
    if os.path.exists(pth):
        data = base64.b64encode(gzip.compress(open(pth, 'rb').read(), 9, mtime=0)).decode()
        suite += '<script type="text/plain" id="suite-' + kind + '">' + data + '</script>'
head, tail = html.rsplit('</body>', 1); html = head + suite + '</body>' + tail
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
out = os.path.join(ROOT, 'dist', 'dawters.html')
open(out, 'w', encoding='utf-8').write(html)
print('wrote', out, len(html) // 1024, 'KB')
# the wasm encoder ships next to the page (web zip, Android assets); the Mac app uses a native ffmpeg instead
import shutil
ff = os.path.join(ROOT, 'dist', 'ff'); os.makedirs(ff, exist_ok=True)
shutil.copy2(os.path.join(ROOT, 'vendor', 'THIRD-PARTY.txt'), ff)
for f in ['ffmpeg-core.js', 'ffmpeg-core.wasm']:
    src = os.path.join(ROOT, 'vendor', 'ffmpeg-wasm', f)
    if not os.path.exists(os.path.join(ff, f)) or os.path.getmtime(src) > os.path.getmtime(os.path.join(ff, f)): shutil.copy2(src, ff)
