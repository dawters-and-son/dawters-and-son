#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Headless check of the 0.3 live controls: Play starts an empty grid, Capture keeps what you played,
# Fade out (and cancel), Stop at the end of the bar, and pedal keys C / F.
import http.server, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/inc'
os.makedirs(OUT, exist_ok=True)
PORT = 8794
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)
def until(p, js, ms):
    t = time.time()
    while time.time() - t < ms / 1000:
        if p.evaluate(js): return True
        p.wait_for_timeout(100)
    return False
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1440, 'height': 1000})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script("localStorage.setItem('increaser.seen','1');localStorage.setItem('increaser.prefs',JSON.stringify({source:'test',test:9,loopBars:2,tempo:240,lead:4,tab:'build',punchOut:'pass',fadeBars:2}))")
    pg.goto(f'http://127.0.0.1:{PORT}/increaser.html'); pg.wait_for_timeout(300)
    I = 'window.__inc'
    # 1. Play with no loop starts the grid (and the click)
    pg.click('#bPlay')
    ok(until(pg, f"{I}.T.playing && {I}.loop.L > 0", 3000), 'Play with no loop starts the grid')
    ok(pg.evaluate(f"{I}.S.click"), 'and turns the click on so you can play along')
    # 2. Capture before a full loop has gone by says so; after, it keeps the last loop
    pg.click('#bCap'); pg.wait_for_timeout(300)
    ok(pg.evaluate(f"{I}.tracks[0].active.length === 0") and 'Not enough played' in pg.inner_text('#toast'), 'Capture too early: nothing kept, and it says why')
    until(pg, f"{I}.Gnow() > {I}.loop.L * 1.2", 6000)
    pg.click('#bCap')
    ok(until(pg, f"{I}.tracks[0].active.length === 1", 2000), 'Capture keeps the last loop on cup 1')
    lay = pg.evaluate(f"(() => {{ const l = {I}.layers.get({I}.tracks[0].active[0]); return [l.n, l.s, {I}.loop.L, Math.max(...l.Lb.slice(0, 40000).map(Math.abs))]; }})()")
    ok(abs(lay[0] - lay[2]) < 2 and lay[3] > 0.05, 'the capture is one loop long and has the band in it (%s)' % lay[:3])
    ok(pg.evaluate("document.querySelector('.cup.sel .no').textContent") == 'No.2', 'moves on to the next cup')
    # 3. pedal key C captures onto cup 2
    pg.mouse.click(5, 400)
    pg.keyboard.press('KeyC')
    ok(until(pg, f"{I}.tracks[1].active.length === 1", 2000), 'C key captures onto cup 2')
    pg.screenshot(path=f'{OUT}/l1-captured.png')
    # 4. Fade out, cancel, fade out to the end
    pg.click('#bFade'); pg.wait_for_timeout(500)
    ok(pg.evaluate(f"{I}.T.fade >= 0") and pg.evaluate("document.getElementById('bFade').classList.contains('on')"), 'Fade out starts, the button shows it')
    g1 = pg.evaluate(f"{I}.T.fadeG")
    pg.screenshot(path=f'{OUT}/l2-fading.png')
    pg.keyboard.press('KeyF'); pg.wait_for_timeout(1200)
    ok(pg.evaluate(f"{I}.T.playing && {I}.T.fade < 0 && {I}.T.fadeG > {g1}"), 'F cancels the fade and the level comes back (%.2f → %.2f)' % (g1, pg.evaluate(f"{I}.T.fadeG")))
    pg.click('#bFade')
    ok(until(pg, f"!{I}.T.playing", 6000), 'a full fade stops the looper')
    G = pg.evaluate(f"{I}.T.G")
    # 5. Stop at the end of the bar
    pg.evaluate(f"{I}.S.stopMode = 'bar'")
    pg.click('#bPlay'); pg.wait_for_timeout(700)
    pg.click('#bPlay'); pg.wait_for_timeout(100)
    ok(pg.evaluate(f"{I}.T.playing"), 'Stop at end of bar keeps playing until the line')
    ok(until(pg, f"!{I}.T.playing", 2500), 'then stops')
    pg.click('#bPlay'); pg.wait_for_timeout(300); pg.click('#bPlay'); pg.wait_for_timeout(60); pg.click('#bPlay'); pg.wait_for_timeout(150)
    ok(pg.evaluate(f"!{I}.T.playing"), 'pressing Stop twice stops at once')
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/l3-phone.png')
    ok(pg.evaluate('document.documentElement.scrollWidth') <= 390, 'no horizontal scroll on a phone')
    ok(not errs, 'no page errors ' + ' | '.join(errs[:3]))
    b.close()
srv.shutdown()
print('FAILED %d' % len(fails) if fails else 'all passed')
sys.exit(1 if fails else 0)
