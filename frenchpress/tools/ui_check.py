"""Drive French Press in headless Chrome: demo song -> press -> every tab -> edits -> export. Screenshots + console errors."""
import sys, json, time, pathlib
from playwright.sync_api import sync_playwright
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/fpshots'); OUT.mkdir(exist_ok=True, parents=True)
URL = 'file:///home/claude/dawters-and-son/frenchpress/dist/frenchpress.html#notitle'
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    for (w, h, tag) in [(1440, 900, 'desk'), (390, 844, 'phone')]:
        pg = b.new_page(viewport={'width': w, 'height': h}, accept_downloads=True)
        pg.on('console', lambda m: errs.append(f'{tag} {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: errs.append(f'{tag} pageerror: {e}'))
        pg.goto(URL); pg.wait_for_timeout(500)
        pg.screenshot(path=str(OUT / f'{tag}-0-welcome.png'))
        pg.click('#demoBtn'); pg.wait_for_selector('#pressBtn', state='visible'); pg.wait_for_timeout(300)
        pg.screenshot(path=str(OUT / f'{tag}-1-setup.png'))
        t = time.time(); pg.click('#pressBtn')
        pg.wait_for_selector('#result:not(.hidden)', timeout=120000); print(tag, 'press took', round(time.time() - t, 1), 's')
        print(tag, pg.inner_text('#result')[:400].replace('\n', ' | '))
        pg.screenshot(path=str(OUT / f'{tag}-2-result.png'), full_page=True)
        for tab in ['edit', 'mix', 'master', 'export']:
            pg.click(f'#tabs button[data-tab={tab}]'); pg.wait_for_timeout(500)
            pg.screenshot(path=str(OUT / f'{tag}-3-{tab}.png'))
        if tag == 'desk':
            pg.click('#tabs button[data-tab=edit]'); pg.wait_for_timeout(300)
            box = pg.locator('#timeline').bounding_box()
            pg.mouse.move(box['x'] + 200, box['y'] + 40); pg.mouse.down(); pg.mouse.move(box['x'] + 500, box['y'] + 220, steps=8); pg.mouse.up()
            print('sel:', pg.inner_text('#selInfo'))
            pg.screenshot(path=str(OUT / 'desk-4-sel.png'))
            pg.evaluate("FPAPI.doOp({type:'gain', stems: FP.view.sel.stems, x0: FP.view.sel.x0, x1: FP.view.sel.x1, db: -12})"); pg.wait_for_timeout(800)
            pg.click('#modeSeg button[data-m=spec]'); pg.wait_for_timeout(300)
            pg.mouse.move(box['x'] + 300, box['y'] + 60); pg.mouse.down(); pg.mouse.move(box['x'] + 600, box['y'] + 120, steps=8); pg.mouse.up()
            print('spec sel:', pg.inner_text('#selInfo'))
            pg.evaluate("FPAPI.doOp({type:'smove', stems: FP.view.sel.stems, to:'other', x0: FP.view.sel.x0, x1: FP.view.sel.x1, flo: FP.view.sel.flo, fhi: FP.view.sel.fhi})"); pg.wait_for_timeout(1500)
            pg.screenshot(path=str(OUT / 'desk-5-spec.png'))
            # sum check after sum-preserving smove: compare against original minus the gain edit region
            r = pg.evaluate("""() => { const B=FP.split.buffers, n=FP.split.names; let e=0; const s=FP.ops[0]; for (let c=0;c<2;c++){ const o=c?FP.R:FP.L; for(let i=0;i<FP.len;i++){ if(i>=s.x0-1&&i<s.x1+1) continue; let t=0; for(const k of n) t+=B[k].getChannelData(c)[i]; e=Math.max(e,Math.abs(t-o[i])); } } return [e, FP.ops.length, FP.undo.length]; }""")
            print('max sum error outside the gain edit, ops, undo:', r)
            pg.evaluate("FPAPI.undo()"); pg.wait_for_timeout(500); pg.evaluate("FPAPI.undo()"); pg.wait_for_timeout(500)
            r2 = pg.evaluate("""() => { const B=FP.split.buffers, n=FP.split.names; let e=0; for (let c=0;c<2;c++){ const o=c?FP.R:FP.L; for(let i=0;i<FP.len;i++){ let t=0; for(const k of n) t+=B[k].getChannelData(c)[i]; e=Math.max(e,Math.abs(t-o[i])); } } return e; }""")
            print('after 2 undos, max sum error:', r2)
            # mix: open strip, master: analyse + match
            pg.click('#tabs button[data-tab=mix]'); pg.wait_for_timeout(300)
            pg.click('#moves button:has-text("Vocal forward")'); pg.wait_for_timeout(300)
            pg.screenshot(path=str(OUT / 'desk-6-mix.png'))
            pg.click('#tabs button[data-tab=master]'); pg.wait_for_timeout(300)
            pg.click('#mrecipes button:has-text("Punchy")'); pg.click('#matchBtn')
            pg.wait_for_function("document.getElementById('analysis').textContent.indexOf('Lands on')>=0", timeout=60000)
            print('match:', pg.inner_text('#analysis').replace('\n', ' | '))
            pg.click('#togglePlayDummy', timeout=100) if False else None
            pg.click('#playBtn'); pg.wait_for_timeout(2500)
            pg.screenshot(path=str(OUT / 'desk-7-master-playing.png'))
            print('loud readouts:', pg.inner_text('#lM'), pg.inner_text('#lS'), pg.inner_text('#lP'), 'clock', pg.inner_text('#clock'))
            pg.click('#playBtn')
            # export: all three, mp3 + wav
            pg.click('#tabs button[data-tab=export]'); pg.check('#xProc'); pg.check('#xRaw')
            with pg.expect_download(timeout=120000) as dl:
                pg.click('#exportBtn')
            d = dl.value; path = OUT / d.suggested_filename; d.save_as(str(path)); print('export:', d.suggested_filename, path.stat().st_size, '|', pg.inner_text('#exportReport').replace('\n', ' | '))
            pg.select_option('#fmtSel', 'mp3-320'); pg.uncheck('#xProc'); pg.uncheck('#xRaw')
            with pg.expect_download(timeout=120000) as dl:
                pg.click('#exportBtn')
            d = dl.value; path = OUT / d.suggested_filename; d.save_as(str(path)); print('export mp3:', d.suggested_filename, path.stat().st_size)
            with pg.expect_download(timeout=60000) as dl:
                pg.click('#saveProjBtn')
            d = dl.value; path = OUT / d.suggested_filename; d.save_as(str(path)); print('project:', d.suggested_filename, path.stat().st_size)
        pg.close()
    b.close()
print('\n'.join(errs) if errs else 'no console errors')
