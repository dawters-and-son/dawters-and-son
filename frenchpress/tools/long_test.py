import time, sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required','--enable-precise-memory-info'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto('file:///home/claude/dawters-and-son/frenchpress/dist/frenchpress.html#notitle'); pg.wait_for_timeout(300)
    pg.set_input_files('#fileIn', sys.argv[1]); pg.wait_for_selector('#pressBtn', state='visible', timeout=60000)
    t=time.time(); pg.click('#pressBtn'); pg.wait_for_selector('#result:not(.hidden)', timeout=900000)
    print('pressed in', round(time.time()-t,1), 's;', pg.inner_text('#result').split('\n')[0])
    print('heap MB', pg.evaluate('performance.memory.usedJSHeapSize/1048576|0'))
    pg.click('#tabs button[data-tab=edit]'); pg.wait_for_timeout(500); pg.click('#modeSeg button[data-m=spec]'); pg.wait_for_timeout(800)
    pg.screenshot(path='/tmp/fpshots/long-spec.png')
    t=time.time(); pg.click('#tabs button[data-tab=master]'); pg.click('#matchBtn'); pg.wait_for_function("document.getElementById('analysis').textContent.indexOf('Lands on')>=0", timeout=600000)
    print('match target took', round(time.time()-t,1),'s', pg.inner_text('#analysis').split('\n')[0])
    print('errors:', errs[:5])
