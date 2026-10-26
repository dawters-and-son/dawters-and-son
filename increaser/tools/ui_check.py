#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Headless Chromium walk-through with a fake microphone: real clicks and keys, screenshots, console errors.
import http.server, os, socketserver, sys, threading, time, json
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/inc'
os.makedirs(OUT, exist_ok=True)
PORT = 8799
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []
def until(page, js, ms):
    t0 = time.time()
    while time.time() - t0 < ms / 1000:
        if page.evaluate(js): return True
        page.wait_for_timeout(150)
    return False
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    ctx.grant_permissions(['microphone'])
    page = ctx.new_page()
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.add_init_script("localStorage.setItem('increaser.seen','1')")
    page.goto(f'http://127.0.0.1:{PORT}/increaser.html')
    page.wait_for_timeout(600)
    page.screenshot(path=f'{OUT}/01-desktop-empty.png')

    st = lambda: page.evaluate("(() => { const i = window.__inc; return { playing: i.T.playing, recs: i.T.recs, L: i.loop.L, base: i.loop.baseTempo, r: i.T.r, layers: i.tracks.map(t => t.active.length), sel: document.querySelector('.cup.sel .no').textContent, mute: i.tracks.map(t => t.mute) }; })()")

    # fast grid for the test: 2 bars at 240
    page.click('.tabs >> text=Punch')
    page.select_option('.pane >> select >> nth=0', '2') if False else None
    page.evaluate("window.__inc.S.loopBars = 2; window.__inc.setTempo(240)")
    # press right away, while the audio worklet is still loading: the first press must not be lost
    page.evaluate("window.__inc.S.source = 'test'; window.__inc.S.test = 9; window.__inc.main(0)")
    ok(until(page, "window.__inc.T.recs.length === 1", 3000), 'a press during audio start-up still arms the cup')
    page.evaluate("window.__inc.newSession()")
    page.click('.tabs >> text=Input')
    page.click('.pane >> text=Test band')
    page.select_option('.pane select', '9')
    # 1. hands-free first take: one press, count-in, auto punch-out after one pass
    page.click('#bMain')
    page.wait_for_timeout(500)
    page.screenshot(path=f'{OUT}/02-countdown.png')
    s = st(); ok(s['playing'] and len(s['recs']) == 1, 'one press: transport counts in with cup 1 armed')
    page.wait_for_timeout(1300)
    page.screenshot(path=f'{OUT}/03-recording.png')
    s = st(); ok(any(r['on'] for r in s['recs']), 'recording started on the downbeat by itself')
    page.wait_for_timeout(2200)
    s = st(); ok(s['layers'][0] == 1 and not s['recs'], 'take ended by itself after one pass (layers %s)' % s['layers'])
    ok(abs(s['L'] - 2 * 4 * 0.25 * 48000) < 1 or abs(s['L'] - 2 * 4 * 0.25 * 44100) < 1, 'loop = 2 bars at 240 BPM (%s frames)' % s['L'])
    ok(s['sel'] == 'No.2', 'advanced to the next empty cup')

    # 2. microphone overdub via the space bar (fake device)
    page.click('.tabs >> text=Input')
    page.click('.pane >> text=Microphone / interface')
    page.wait_for_timeout(500)
    page.mouse.click(5, 300)
    page.keyboard.press('Space')
    page.wait_for_timeout(200)
    s = st(); ok(len(s['recs']) == 1 and s['recs'][0]['track'] == 1, 'Space arms cup 2 (mic)')
    until(page, "window.__inc.tracks[1].active.length === 1 && !window.__inc.T.recs.length", 8000)
    s = st(); ok(s['layers'][1] == 1, 'mic take recorded on cup 2')
    peak = page.evaluate("Math.max(...window.__inc.layers.get(window.__inc.tracks[1].active[0]).Lb.map(Math.abs))")
    ok(peak > 0.01, 'mic take has signal (peak %.3f)' % peak)

    # 3. increase mode on cup 3: three passes, three layers
    page.click('.tabs >> text=Punch')
    page.click('.pane >> text=Passes')
    page.select_option('.pane >> select >> nth=0', '3')
    page.click('.tabs >> text=Input'); page.click('.pane >> text=Test band')
    page.keyboard.press('Digit3'); page.keyboard.press('Space')
    until(page, "window.__inc.tracks[2].active.length === 3 && !window.__inc.T.recs.length", 14000)
    s = st(); ok(s['layers'][2] == 3, 'Passes ×3: cup 3 has three layers (%s)' % s['layers'])
    page.screenshot(path=f'{OUT}/04-three-cups.png')

    # 4. undo by key, then redo
    page.keyboard.press('Backspace'); page.wait_for_timeout(100)
    s = st(); ok(s['layers'][2] == 2, 'Backspace undoes one layer')
    page.keyboard.press('KeyY'); page.wait_for_timeout(100)
    s = st(); ok(s['layers'][2] == 3, 'Y redoes it')

    # 5. tempo moves while playing; loops keep pitch
    page.click('#tUp'); page.wait_for_timeout(200)
    s = st(); ok(abs(s['r'] * s['base'] - 241) < 0.01, 'tempo +1 while playing → 241')
    page.click('.tabs >> text=Tempo')
    page.fill('.pane input[type=number] >> nth=1', '252')
    page.click('.pane >> text=Start ramp')
    until(page, "Math.abs(window.__inc.T.r * window.__inc.loop.baseTempo - 252) < 0.05", 12000)
    s = st(); ok(abs(s['r'] * s['base'] - 252) < 0.05, 'ramp lands on 252 (%.2f)' % (s['r'] * s['base']))
    page.screenshot(path=f'{OUT}/05-tempo.png')

    # 6. quick build-up schedules mutes on bar lines
    page.click('.tabs >> text=Build')
    page.click('.pane >> text=Build up')
    page.wait_for_timeout(1200)
    s = st(); ok(all(s['mute'][i] for i in range(1, 3)), 'build-up: later cups muted, waiting their turn (%s)' % s['mute'])

    # 7. run a recipe: two more cups hands-free
    page.evaluate("window.__inc.quickBuild('all')")
    page.evaluate("window.__inc.S.recipe = [{a:'rec',t:3,bars:0},{a:'mute',t:0},{a:'rec',t:4,bars:1},{a:'unmute',t:0}]")
    page.click('.tabs >> text=Tempo'); page.click('.tabs >> text=Build')
    page.click('#bRun')
    page.wait_for_timeout(600)
    page.screenshot(path=f'{OUT}/06-build-running.png')
    until(page, "window.__inc.tracks[4].active.length === 1 && !window.__inc.T.recs.length", 16000)
    page.wait_for_timeout(800)
    s = st(); ok(s['layers'][3] == 1 and s['layers'][4] == 1, 'recipe recorded cups 4 and 5 back to back (%s)' % s['layers'])
    ok(not s['mute'][0], 'recipe muted and brought back cup 1')

    # 8. pedal learn: bind KeyQ to next cup
    page.click('.tabs >> text=Pedal')
    page.click('.bind[data-a="next"] >> text=Learn')
    page.keyboard.press('KeyQ'); page.wait_for_timeout(100)
    before = st()['sel']; page.keyboard.press('KeyQ'); page.wait_for_timeout(100)
    ok(st()['sel'] != before, 'learned pedal (Q) moves to the next cup')
    page.screenshot(path=f'{OUT}/07-pedal.png')

    # 9. exports
    page.click('.tabs >> text=Export')
    with page.expect_download() as d: page.click('.pane >> text=Loop mix')
    path = d.value.path(); size = os.path.getsize(path)
    ok(d.value.suggested_filename.endswith('.wav') and size > 100000, 'loop mix WAV downloads (%d bytes)' % size)
    with page.expect_download() as d: page.click('.pane >> text=Stems (zip)')
    ok(d.value.suggested_filename.endswith('.zip'), 'stems zip downloads')
    with page.expect_download() as d: page.click('.pane >> text=Save session')
    sess = d.value.path()
    page.click('#bSet'); page.wait_for_timeout(1500)
    with page.expect_download() as d: page.click('#bSet')
    ok(os.path.getsize(d.value.path()) > 48000 * 6, 'set recording saves a WAV of what played')
    # reopen the session
    page.evaluate("window.__inc.newSession()")
    page.set_input_files('.pane input[type=file]', sess)
    page.wait_for_timeout(800)
    s = st(); ok(s['layers'][:5] == [1, 1, 3, 1, 1], 'session reopens with every layer (%s)' % s['layers'])
    page.click('#bPlay'); page.wait_for_timeout(1500)
    page.screenshot(path=f'{OUT}/08-reopened.png')

    # 10. late show + phone
    page.click('#bTheme'); page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/09-late-show.png')
    page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/10-phone.png', full_page=True)
    sw = page.evaluate('document.documentElement.scrollWidth')
    ok(sw <= 390, 'no horizontal scroll at 390 px (%d)' % sw)
    page.click('#bTheme')
    page.screenshot(path=f'{OUT}/11-phone-day.png')
    ok(not errs, 'no console errors' + ('' if not errs else ': ' + ' | '.join(errs[:5])))
    b.close()
srv.shutdown()
print('FAILED: %d' % len(fails) if fails else 'all passed')
sys.exit(1 if fails else 0)
