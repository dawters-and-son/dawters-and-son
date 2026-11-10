#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build France's French Press into one self-contained HTML file: dist/frenchpress.html"""
import base64, os, re, pathlib, zipfile
V = '1.1.1'
ROOT = pathlib.Path(__file__).parent
SRC, DIST = ROOT / 'src', ROOT / 'dist'
VENDOR = ROOT / 'vendor'
def font_face(fam, path, weight=400, style='normal'):
    b = base64.b64encode((VENDOR / path).read_bytes()).decode()
    return "@font-face{font-family:'%s';font-style:%s;font-weight:%d;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}" % (fam, style, weight, b)
def build():
    DIST.mkdir(exist_ok=True)
    html = (SRC / 'index.html').read_text()
    fonts = '<style>' + ''.join([
        font_face('Yesteryear', 'fonts/yesteryear-latin-400-normal.woff2'),
        font_face('Oswald', 'fonts/oswald-latin-400-normal.woff2', 400),
        font_face('Oswald', 'fonts/oswald-latin-600-normal.woff2', 600),
        font_face('Courier Prime', 'fonts/courier-prime-latin-400-normal.woff2', 400),
        font_face('Courier Prime', 'fonts/courier-prime-latin-700-normal.woff2', 700),
        font_face('Courier Prime', 'fonts/courier-prime-latin-400-italic.woff2', 400, 'italic'),
    ]) + '</style>'
    app = '\n'.join((SRC / f).read_text() for f in ['ui.js', 'audio.js', 'engine.js', 'app.js'])
    lame = (VENDOR / 'lame.min.js').read_text()
    for name, s in [('dsp', (SRC / 'dsp.js').read_text()), ('lame', lame), ('app', app)]:
        assert '</script' not in s.lower(), name
    rep = {'<!--FONTS-->': fonts, '/*STYLE*/': (SRC / 'style.css').read_text(), '<!--LOGO-->': (SRC / 'logo.svg').read_text(),
           '/*DSP*/': (SRC / 'dsp.js').read_text(), '/*LAME*/': lame, '/*APP*/': app}
    for k, v in rep.items():
        assert k in html, k
        html = html.replace(k, v)
    out = DIST / 'frenchpress.html'
    out.write_text(html)
    z = DIST / ('French-Press-%s-web.zip' % V)
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.write(out, "France's French Press/index.html")
        zf.write(ROOT / 'LICENSE', "France's French Press/LICENSE")
    print(out, round(out.stat().st_size / 1024), 'KB;', z.name)
if __name__ == '__main__':
    build()
