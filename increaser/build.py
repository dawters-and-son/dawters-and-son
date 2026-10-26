#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Builds dist/increaser.html (one self-contained file) and the web zip with a local launcher."""
import base64, os, zipfile
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src'); DIST = os.path.join(ROOT, 'dist')
V = '0.3.0'
def rd(*p): return open(os.path.join(SRC, *p), encoding='utf-8').read()
fonts = [('Yesteryear', 400, 'yesteryear-latin-400-normal.woff2'), ('Oswald', 400, 'oswald-latin-400-normal.woff2'),
         ('Oswald', 600, 'oswald-latin-600-normal.woff2'), ('Courier Prime', 400, 'courier-prime-latin-400-normal.woff2'),
         ('Courier Prime', 700, 'courier-prime-latin-700-normal.woff2')]
ff = ''
for fam, w, f in fonts:
    b = base64.b64encode(open(os.path.join(SRC, 'fonts', f), 'rb').read()).decode()
    ff += "@font-face{font-family:'%s';font-weight:%d;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}\n" % (fam, w, b)
html = rd('index.html')
for k, v in [('/*FONTS*/', ff), ('/*STYLE*/', rd('style.css')), ('/*ENGINE*/', rd('engine.js')), ('/*APP*/', rd('app.js'))]:
    assert '</script' not in v.lower() or k in ('/*FONTS*/', '/*STYLE*/')
    html = html.replace(k, v, 1)
os.makedirs(DIST, exist_ok=True)
out = os.path.join(DIST, 'increaser.html')
open(out, 'w', encoding='utf-8').write(html)
z = os.path.join(DIST, 'The-Increaser-%s-web.zip' % V)
with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(out, 'The Increaser/index.html')
    for f in os.listdir(os.path.join(ROOT, 'web')):
        zf.write(os.path.join(ROOT, 'web', f), 'The Increaser/' + f)
    zf.write(os.path.join(ROOT, 'LICENSE'), 'The Increaser/LICENSE')
print(out, os.path.getsize(out), 'bytes;', z)
