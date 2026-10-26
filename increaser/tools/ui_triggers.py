#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Headless check of the 0.2 trigger options: start on sound, stop when I stop, gate, keep-last, retake,
# and a first press made while audio is still starting.
import http.server, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/inc'
os.makedirs(OUT, exist_ok=True)
PORT = 8795
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
    pg.add_init_script("localStorage.setItem('increaser.seen','1');localStorage.setItem('increaser.prefs',JSON.stringify({source:'test',test:5,loopBars:2,tempo:240,lead:4,tab:'punch',punchOut:'pass'}))")
    pg.goto(f'http://127.0.0.1:{PORT}/increaser.html'); pg.wait_for_timeout(300)
    I = 'window.__inc'
    # 1. the very first press, before audio has started, still records
    pg.click('#bMain')
    ok(until(pg, f"{I}.tracks[0].active.length === 1 && !{I}.T.recs.length", 8000), 'first press on a cold page records (audio-start race fixed)')
    # 2. start on sound: arm on cup 2 with the band silent, then play
    pg.click('.pane >> text=My first note')
    pg.evaluate(f"{I}.S.test = 0; {I}.send({{c:'set', test:0}}); {I}.select(1)")
    pg.keyboard.press('Space'); pg.wait_for_timeout(900)
    ok(pg.evaluate(f"{I}.T.recs.length === 1 && {I}.T.recs[0].trigger && {I}.tracks[1].active.length === 0"), 'start on sound: cup 2 waits while it is quiet')
    pg.screenshot(path=f'{OUT}/t1-listening.png')
    g0 = pg.evaluate(f"{I}.Gnow()")
    pg.evaluate(f"{I}.S.test = 5; {I}.send({{c:'set', test:5}})")
    ok(until(pg, f"{I}.T.recs.length && {I}.T.recs[0].on", 1500), 'start on sound: recording begins when the tone starts')
    ok(until(pg, f"{I}.tracks[1].active.length === 1 && !{I}.T.recs.length", 6000), 'start on sound: one pass recorded')
    s = pg.evaluate(f"{I}.layers.get({I}.tracks[1].active[0]).s")
    L = pg.evaluate(f"{I}.loop.L")
    ok(s % L != 0, 'the sound-started take sits where the note began, not on bar 1 (s=%d)' % s)
    # 3. stop when I stop, with count-in, on cup 3
    pg.click('.pane >> text=Count-in')
    pg.click('.pane >> text=I stop')
    pg.select_option('#silSel', '0.5')
    pg.evaluate(f"{I}.select(2)")
    pg.keyboard.press('Space')
    ok(until(pg, f"{I}.T.recs.length && {I}.T.recs[0].on", 4000), 'stop when I stop: take running')
    pg.wait_for_timeout(2600)   # longer than one pass: still going while the tone plays
    ok(pg.evaluate(f"{I}.T.recs.length === 1"), 'stop when I stop: keeps recording past one pass while you play')
    pg.evaluate(f"{I}.S.test = 0; {I}.send({{c:'set', test:0}})")
    ok(until(pg, f"!{I}.T.recs.length", 4000), 'stop when I stop: ends after you go quiet')
    n3 = pg.evaluate(f"{I}.tracks[2].active.length")
    ok(n3 >= 1, 'stop when I stop: kept %d layer(s)' % n3)
    # 4. keep the last layer: every pass replaces the one before
    pg.evaluate(f"{I}.select(3)")
    pg.select_option('#keepSel', '1')
    pg.click('.pane >> text=My press')
    pg.evaluate(f"{I}.S.test = 5; {I}.send({{c:'set', test:5}})")
    pg.keyboard.press('Space')
    ok(until(pg, f"{I}.T.recs.length && {I}.T.recs[0].on", 4000), 'keep last: running')
    until(pg, f"{I}.T.recs.length && {I}.T.recs[0].passes >= 3", 9000)
    pg.keyboard.press('Space')
    ok(until(pg, f"!{I}.T.recs.length", 4000), 'keep last: punched out')
    k = pg.evaluate(f"[{I}.tracks[3].active.length, {I}.tracks[3].undo.length]")
    ok(k[0] == 1 and k[1] >= 3, 'keep last: three or more passes, only the latest plays (%s)' % k)
    pg.keyboard.press('Backspace'); pg.wait_for_timeout(100)
    ok(pg.evaluate(f"{I}.tracks[3].active.length === 1 && {I}.tracks[3].undo.length === %d" % (k[1] - 1)), 'keep last: undo brings back the pass before')
    # 5. retake: cup 1 gets its take redone in the same place
    pg.evaluate(f"{I}.select(0)")
    before = pg.evaluate(f"[{I}.tracks[0].active[0], {I}.layers.get({I}.tracks[0].active[0]).s]")
    pg.keyboard.press('KeyR')
    ok(until(pg, f"{I}.T.recs.length === 1 && {I}.T.recs[0].track === 0", 1500) and pg.evaluate(f"{I}.tracks[0].active.length === 0"), 'retake: last take removed and the same cup armed')
    ok(until(pg, f"{I}.tracks[0].active.length === 1 && !{I}.T.recs.length", 8000), 'retake: new take recorded')
    after = pg.evaluate(f"[{I}.tracks[0].active[0], {I}.layers.get({I}.tracks[0].active[0]).s, {I}.layers.get({I}.tracks[0].active[0]).n]")
    ok(after[0] != before[0] and abs(after[1] - before[1]) < 2 and abs(after[2] - L) < 2, 'retake: same spot and length (%s → %s)' % (before, after))
    ok(pg.evaluate(f"document.querySelector('.cup.sel .no').textContent") == 'No.1', 'retake stays on its cup')
    pg.screenshot(path=f'{OUT}/t2-punch-pane.png')
    pg.locator('.bar').screenshot(path=f'{OUT}/t3-punch-panel.png')
    ok(not errs, 'no page errors ' + ' | '.join(errs[:3]))
    b.close()
srv.shutdown()
print('FAILED %d' % len(fails) if fails else 'all passed')
sys.exit(1 if fails else 0)
