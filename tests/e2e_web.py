import json, sys, base64
from playwright.sync_api import sync_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
FAKE_STYLE = {"version": 8, "glyphs": "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", "sources": {},
              "layers": [{"id": "bg", "type": "background", "paint": {"background-color": "#eef0ea"}},
                         {"id": "lbl", "type": "symbol", "source": "x", "layout": {}}][:1]}
PNG1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
def handler(route):
    u = route.request.url
    if u.startswith('http://localhost'): return route.continue_()
    if 'openfreemap.org/styles' in u: return route.fulfill(body=json.dumps(FAKE_STYLE), content_type='application/json')
    if 'photon.komoot.io/api' in u:
        return route.fulfill(body=json.dumps({"features": [{"geometry": {"coordinates": [9.19, 45.465]}, "properties": {"name": "Via Test", "city": "Milano"}}]}), content_type='application/json')
    if 'photon.komoot.io/reverse' in u:
        return route.fulfill(body=json.dumps({"features": [{"properties": {"street": "Via Prova", "housenumber": "3", "city": "Milano"}}]}), content_type='application/json')
    if 'arcgisonline' in u: return route.fulfill(body=PNG1, content_type='image/png')
    return route.fulfill(status=404, body='')
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
    pg.on('console', lambda m: errs.append('console ' + m.text) if m.type == 'error' and 'fonts' not in m.text and '404' not in m.text else None)
    pg.route('**/*', handler)
    pg.goto(URL + '#map=12/45.47/9.20')
    pg.wait_for_function("window.__app && window.__app.overlaysOn", timeout=30000)
    pg.wait_for_function("window.__app.map.areTilesLoaded()", timeout=30000); pg.wait_for_timeout(1500)
    # pixel non trasparenti nel canvas della mappa
    nonbg = pg.evaluate("""() => { const c=document.querySelector('#map canvas'); const g=document.createElement('canvas'); g.width=c.width; g.height=c.height; const x=g.getContext('2d'); x.drawImage(c,0,0); const d=x.getImageData(0,0,g.width,g.height).data; let n=0; for(let i=0;i<d.length;i+=40){ if(!(d[i]==238&&d[i+1]==240&&d[i+2]==234)) n++; } return n; }""")
    print('pixel colorati (campione):', nonbg)
    pg.screenshot(path='/home/claude/mappa-zone-buone/.cache_test/shot_map.png')
    # clic → scheda
    pg.mouse.click(900, 450); pg.wait_for_selector('#cardBody .big', timeout=15000); pg.wait_for_timeout(800)
    print('SCHEDA:', pg.inner_text('#cardBody')[:500].replace('\n', ' | '))
    # peso dal vivo
    t0 = pg.evaluate("performance.now()")
    pg.evaluate("""() => { const r=document.querySelector('#groupSliders input'); r.value=300; r.dispatchEvent(new Event('input')); }""")
    pg.wait_for_timeout(300); pg.wait_for_function("window.__app.map.areTilesLoaded()", timeout=20000)
    print('ricolorazione dopo cambio peso (ms):', round(pg.evaluate("performance.now()") - t0))
    pg.screenshot(path='/home/claude/mappa-zone-buone/.cache_test/shot_weight.png')
    # strumento analisi area
    pg.click('#tabs button[data-p=p-tools]'); pg.click('[data-tool=stats]')
    for (x, y) in [(600, 300), (1000, 300), (1000, 650), (600, 650)]: pg.mouse.click(x, y); pg.wait_for_timeout(120)
    pg.mouse.dblclick(600, 650); pg.wait_for_selector('#toolOut .hist', timeout=15000)
    print('ANALISI:', pg.inner_text('#toolOut')[:300].replace('\n', ' | '))
    # filtro
    pg.evaluate("() => { const c=document.getElementById('fOn'); c.checked=true; c.dispatchEvent(new Event('change')); }"); pg.evaluate("""() => { const r=document.getElementById('fComb'); r.value=40; r.dispatchEvent(new Event('input')); }""")
    pg.wait_for_timeout(500)
    pg.screenshot(path='/home/claude/mappa-zone-buone/.cache_test/shot_filter.png')
    # salva immobile e confronto
    pg.click('#cSave'); pg.mouse.click(700, 520); pg.wait_for_timeout(1200); pg.click('#cSave')
    pg.click('#tabs button[data-p=p-props]'); pg.wait_for_timeout(800)
    print('IMMOBILI:', pg.inner_text('#propList')[:200].replace('\n', ' | '))
    pg.click('#cmpOpen'); pg.wait_for_selector('#cmpBody table', timeout=10000); pg.wait_for_timeout(1500)
    print('CONFRONTO righe:', pg.evaluate("document.querySelectorAll('#cmpBody tr').length"), '| img:', pg.evaluate("(document.getElementById('cmpMap').src||'').slice(0,22)"))
    pg.screenshot(path='/home/claude/mappa-zone-buone/.cache_test/shot_cmp.png'); pg.click('#cmpX')
    # comuni, ricerca, info
    pg.click('#tabs button[data-p=p-comuni]'); print('COMUNI:', pg.inner_text('#comList')[:160].replace('\n', ' | '))
    pg.fill('#q', 'via test'); pg.wait_for_selector('#qres [data-i]', timeout=5000); print('RICERCA ok')
    pg.click('#tabs button[data-p=p-info]'); print('INFO:', pg.inner_text('#infoBox')[:160].replace('\n', ' | '))
    pg.click('#tabs button[data-p=p-index]')
    pg.screenshot(path='/home/claude/mappa-zone-buone/.cache_test/shot_final.png')
    print('ERRORI:', errs[:10])
    b.close()
