import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { Protocol } from 'pmtiles';
import { defaultParams, SCORE_CSS, AIR_CSS } from './codec.js';
import { initCard, openCard, refreshCard } from './card.js';
import { initProps, refreshProps, addPropsLayer } from './props.js';
import { initTools, addDrawLayers } from './tools.js';
import { initComuni } from './comuni.js';
import { initSearch } from './search.js';
import { renderInfo } from './info.js';

const DATA = new URL(import.meta.env.BASE_URL + 'data/', location.href).href;
const $ = id => document.getElementById(id);
const app = { DATA, $, maplibregl, ver: 1 };
window.__app = app;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0; const pending = new Map();
worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); };
app.call = (type, payload = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ id, type, ...payload }); });

app.toast = (msg, ms = 2600) => { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms); };
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };
app.store = store;

// lazy loader per gli indici (fonti, servizi, vento, comuni)
const lazy = {};
app.load = name => lazy[name] || (lazy[name] = fetch(DATA + name).then(r => { if (!r.ok) throw new Error(name); return r.json(); }));

// ---------- stili mappa di base (nessuna chiave API) ----------
const OFM = 'https://tiles.openfreemap.org/styles/';
const SAT = {
  version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { esri: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] } },
  layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
};
const styleFor = k => k === 'sat' ? SAT : OFM + k;

// ---------- parametri ----------
function loadParams(cfg) {
  const d = defaultParams(cfg), s = store.get('mzb_params', null);
  if (!s) return d;
  return { ...d, ...s, groupW: { ...d.groupW, ...s.groupW }, serviceW: { ...d.serviceW, ...s.serviceW }, serviceD: { ...d.serviceD, ...s.serviceD },
    filter: { ...d.filter, ...(s.filter || {}), maxDist: { ...(s.filter || {}).maxDist } } };
}
let pTimer;
app.setParams = (patch, immediate) => {
  Object.assign(app.params, patch || {});
  store.set('mzb_params', app.params);
  clearTimeout(pTimer);
  pTimer = setTimeout(async () => {
    await app.call('params', { params: app.params });
    app.ver++;
    const src = app.map.getSource('score');
    if (src) src.setTiles([`score://{z}/{x}/{y}?v=${app.ver}`]);
    renderLegend(); refreshCard(); refreshProps();
  }, immediate ? 0 : 110);
};

// ---------- avvio ----------
async function boot() {
  let cfg;
  try { cfg = await fetch(DATA + 'config.json').then(r => r.json()); }
  catch (e) { document.body.innerHTML = '<div style="padding:40px;font:15px system-ui">Dati non ancora disponibili: il calcolo su GitHub Actions deve terminare almeno una volta.</div>'; return; }
  app.cfg = cfg;
  app.manifest = await fetch(DATA + 'manifest.json').then(r => r.json()).catch(() => ({}));
  app.params = loadParams(cfg);
  await app.call('init', { url: DATA + 'dati.pmtiles', cfg, params: app.params });

  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  maplibregl.addProtocol('score', async (req) => {
    const m = req.url.match(/score:\/\/(\d+)\/(\d+)\/(\d+)/);
    const r = await app.call('render', { z: +m[1], x: +m[2], y: +m[3] });
    return { data: r.buf };
  });

  const base = store.get('mzb_base', 'positron');
  $('basemap').value = base;
  const map = new maplibregl.Map({
    container: 'map', style: styleFor(base), bounds: cfg.bounds, fitBoundsOptions: { padding: 20 }, hash: 'map',
    attributionControl: { compact: true, customAttribution: 'Dati: © OpenStreetMap, Copernicus CAMS, Open-Meteo, Regione Lombardia, ARPA Lombardia' },
    canvasContextAttributes: { preserveDrawingBuffer: true }, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
  });
  app.map = map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('style.load', addOverlays);
  // se la mappa di base vettoriale non risponde, ripiega sul satellite (stessi livelli di analisi)
  const fallback = () => { if (app.overlaysOn || app.fellBack) return; app.fellBack = true; app.toast('Mappa di base non raggiungibile: passo al satellite'); $('basemap').value = 'sat'; map.setStyle(SAT); };
  map.on('error', e => { if (!app.overlaysOn && /style|openfreemap|Failed to fetch/i.test(String(e.error && e.error.message))) fallback(); });
  setTimeout(fallback, 9000);

  buildIndexPanel(); buildLayerPanel(); renderLegend();
  initCard(app); initProps(app); initTools(app); initComuni(app); initSearch(app); renderInfo(app);
  map.on('click', e => {
    if (app.tool) return;
    const f = map.queryRenderedFeatures(e.point, { layers: ['fonti-fill', 'fonti-pt', 'arpa-pt', 'servizi'].filter(l => map.getLayer(l)) })[0];
    openCard(e.lngLat, f);
  });
  for (const l of ['fonti-fill', 'fonti-pt', 'servizi', 'arpa-pt']) {
    map.on('mouseenter', l, () => { if (!app.tool) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { if (!app.tool) map.getCanvas().style.cursor = ''; });
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('on')); $(b.dataset.p).classList.add('on');
  });
}

// ---------- livelli sovrapposti ----------
function hatchImage(color, angle) {
  const S = 24, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  g.fillStyle = color + '22'; g.fillRect(0, 0, S, S);
  g.strokeStyle = color; g.lineWidth = 3; g.globalAlpha = .85;
  g.translate(S / 2, S / 2); g.rotate(angle * Math.PI / 180);
  for (let k = -2 * S; k <= 2 * S; k += 8) { g.beginPath(); g.moveTo(k, -2 * S); g.lineTo(k, 2 * S); g.stroke(); }
  return g.getImageData(0, 0, S, S);
}
function firstSymbolId(map) { const l = map.getStyle().layers.find(x => x.type === 'symbol'); return l && l.id; }

function addOverlays() {
  app.overlaysOn = true;
  const map = app.map, cfg = app.cfg, before = firstSymbolId(map);
  const cats = cfg.categories, angles = [45, -45, 0, 90];
  Object.keys(cats).forEach((k, i) => { if (!map.hasImage('h-' + k)) map.addImage('h-' + k, hatchImage(cats[k].color, angles[i % 4]), { pixelRatio: 2 }); });
  map.addSource('score', { type: 'raster', tiles: [`score://{z}/{x}/{y}?v=${app.ver}`], tileSize: 256, minzoom: cfg.dataZoom[0], maxzoom: 14, bounds: cfg.bounds });
  map.addLayer({ id: 'score', type: 'raster', source: 'score', paint: { 'raster-opacity': +$('opa').value / 100, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, before);
  map.addSource('vec', { type: 'vector', url: 'pmtiles://' + DATA + 'vettori.pmtiles' });
  const catColor = ['match', ['get', 'cat'], ...Object.entries(cats).flatMap(([k, v]) => [k, v.color]), '#666'];
  const servColor = ['match', ['get', 'type'], ...Object.entries(cfg.services).flatMap(([k, v]) => [k, v.color]), '#666'];
  map.addLayer({ id: 'comuni-fill', type: 'fill', source: 'vec', 'source-layer': 'comuni', layout: { visibility: 'none' },
    paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'comb'], 20, '#a50026', 40, '#f46d43', 55, '#fee08b', 70, '#a6d96a', 85, '#1a9850'], 'fill-opacity': .6 } }, before);
  map.addLayer({ id: 'comuni-line', type: 'line', source: 'vec', 'source-layer': 'comuni', minzoom: 8, layout: { visibility: 'none' }, paint: { 'line-color': '#555', 'line-width': .6, 'line-opacity': .6 } });
  map.addLayer({ id: 'comuni-hl', type: 'line', source: 'vec', 'source-layer': 'comuni', filter: ['==', ['get', 'istat'], '__'], paint: { 'line-color': '#111', 'line-width': 3 } });
  map.addLayer({ id: 'fonti-fill', type: 'fill', source: 'vec', 'source-layer': 'fonti', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-pattern': ['concat', 'h-', ['get', 'cat']] } });
  map.addLayer({ id: 'fonti-line', type: 'line', source: 'vec', 'source-layer': 'fonti', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': catColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, .4, 14, 1.6] } });
  map.addLayer({ id: 'fonti-pt', type: 'circle', source: 'vec', 'source-layer': 'fonti', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': catColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 13, 6], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'servizi', type: 'circle', source: 'vec', 'source-layer': 'servizi', minzoom: 11, layout: { visibility: 'none' },
    paint: { 'circle-color': servColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'arpa-pt', type: 'circle', source: 'vec', 'source-layer': 'arpa', paint: { 'circle-color': '#fff', 'circle-radius': 7, 'circle-stroke-color': '#0d47a1', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'arpa-lab', type: 'symbol', source: 'vec', 'source-layer': 'arpa', minzoom: 9,
    layout: { 'text-field': ['case', ['has', 'pm25'], ['concat', 'PM2.5 ', ['to-string', ['get', 'pm25']]], ['has', 'pm10'], ['concat', 'PM10 ', ['to-string', ['get', 'pm10']]], ''],
      'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' }, paint: { 'text-color': '#0d47a1', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'confine', type: 'line', source: 'vec', 'source-layer': 'confine', paint: { 'line-color': '#333', 'line-width': 1.4, 'line-dasharray': [3, 2] } });
  for (const o of (app.manifest.overlays || []).concat(app.customWms || [])) addWms(o, false);
  addDrawLayers(app); addPropsLayer(app);
  applyLayerVisibility();
}

function addWms(o, visible) {
  const map = app.map, id = 'wms-' + o.service;
  if (map.getSource(id)) return;
  const url = `${o.wms}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=${encodeURIComponent(o.layers)}&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}`;
  map.addSource(id, { type: 'raster', tiles: [url], tileSize: 256 });
  map.addLayer({ id, type: 'raster', source: id, layout: { visibility: (visible || (app.wmsOn || {})[id]) ? 'visible' : 'none' }, paint: { 'raster-opacity': .7 } }, map.getLayer('fonti-fill') ? 'fonti-fill' : undefined);
}

// ---------- pannello indice ----------
const pct = v => Math.round(v * 100) + '%';
function buildIndexPanel() {
  const cfg = app.cfg, P = app.params;
  const bind = (id, get, set, fmt) => { const el = $(id), out = $(id + 'V'); el.value = get(); if (out) out.textContent = fmt(get());
    el.oninput = () => { set(+el.value); if (out) out.textContent = fmt(get()); }; };
  $('mode').value = P.mode.startsWith('g:') ? 'comb' : P.mode;
  for (const g in cfg.groups) { const o = document.createElement('option'); o.value = 'g:' + g; o.textContent = 'Solo: ' + cfg.groups[g].label; $('mode').appendChild(o); }
  $('mode').value = P.mode;
  $('mode').onchange = () => app.setParams({ mode: $('mode').value }, true);
  bind('alpha', () => Math.round(P.alpha * 100), v => app.setParams({ alpha: v / 100 }), v => v + '%');
  bind('aqw', () => Math.round(P.aqW * 10), v => app.setParams({ aqW: v / 10 }), v => '×' + (v / 10).toFixed(1));
  bind('mit', () => Math.round(P.mit * 100), v => app.setParams({ mit: v / 100 }), v => v + '%');
  bind('opa', () => +$('opa').value, v => app.map.getLayer('score') && app.map.setPaintProperty('score', 'raster-opacity', v / 100), v => v + '%');
  const gs = $('groupSliders'); gs.innerHTML = '';
  for (const g in cfg.groups) {
    const d = document.createElement('div'); d.className = 'gs';
    d.innerHTML = `<span class="sw" style="background:${cfg.groups[g].color}"></span><span class="lab">${cfg.groups[g].label}</span><b></b><input type="range" min="0" max="300" step="5">`;
    const r = d.querySelector('input'), b = d.querySelector('b');
    r.value = Math.round((P.groupW[g] ?? 1) * 100); b.textContent = '×' + (r.value / 100).toFixed(2);
    r.oninput = () => { P.groupW[g] = r.value / 100; b.textContent = '×' + (r.value / 100).toFixed(2); app.setParams({}); };
    gs.appendChild(d);
  }
  const ss = $('servSliders'); ss.innerHTML = '';
  for (const s in cfg.services) {
    const sv = cfg.services[s], d = document.createElement('div');
    d.innerHTML = `<div class="gs"><span class="sw" style="background:${sv.color}"></span><span class="lab">${sv.label}</span><b></b><input type="range" min="0" max="40" step="1"></div>
      <div class="svs"><span class="hint">pieno entro (m)</span><input type="number" step="100" min="0" data-k="0"><span class="hint">nullo oltre (m)</span><input type="number" step="100" min="0" data-k="1"></div>`;
    const r = d.querySelector('input[type=range]'), b = d.querySelector('b');
    r.value = Math.round((P.serviceW[s] ?? 0) * 100); b.textContent = r.value;
    r.oninput = () => { P.serviceW[s] = r.value / 100; b.textContent = r.value; app.setParams({}); };
    d.querySelectorAll('input[type=number]').forEach(inp => { inp.value = P.serviceD[s][+inp.dataset.k];
      inp.onchange = () => { P.serviceD[s][+inp.dataset.k] = Math.max(0, +inp.value); app.setParams({}); }; });
    ss.appendChild(d);
  }
  $('resetP').onclick = () => { app.params = defaultParams(cfg); store.set('mzb_params', app.params); $('mode').innerHTML = $('mode').innerHTML; buildIndexPanel(); app.setParams({}, true); app.toast('Pesi predefiniti ripristinati'); };
}

function renderLegend() {
  const m = app.params.mode, cfg = app.cfg, L = $('legend');
  let title, grad = SCORE_CSS, ends = ['0 critico', '100 ottimo'];
  if (m === 'comb') title = 'Indice combinato';
  else if (m === 'sal') title = 'Salubrità';
  else if (m === 'serv') title = 'Dotazione di servizi';
  else if (m === 'aria') { title = 'PM2.5 medio annuo (µg/m³)'; grad = AIR_CSS; ends = ['0', '40 · OMS: 5']; }
  else { title = 'Impatto: ' + cfg.groups[m.slice(2)].label; grad = 'linear-gradient(90deg,rgba(26,152,80,0),#fee08b,#a50026)'; ends = ['nullo', 'forte']; }
  const F = app.params.filter;
  L.innerHTML = `<b>${title}</b><div class="grad" style="background:${grad}"></div><div class="ends"><span>${ends[0]}</span><span>${ends[1]}</span></div>`
    + (F && F.on ? '<div class="hint" style="margin:4px 0 0">Filtro attivo</div>' : '')
    + '<div class="hint" style="margin:2px 0 0">Retini = perimetri delle fonti · clic per la scheda</div>';
}

// ---------- pannello livelli ----------
function buildLayerPanel() {
  const cfg = app.cfg, st = store.get('mzb_layers', {});
  app.activeCats = st.cats || Object.keys(cfg.categories).filter(k => !cfg.categories[k].line);
  app.activeServ = st.serv || [];
  const cl = $('catList'); cl.innerHTML = '';
  for (const k in cfg.categories) {
    const c = cfg.categories[k]; if (c.line) continue;
    cl.insertAdjacentHTML('beforeend', `<label><input type="checkbox" data-cat="${k}" ${app.activeCats.includes(k) ? 'checked' : ''}><span class="sw" style="background:${c.color}"></span>${c.label}<span class="n">${c.count ?? ''}</span></label>`);
  }
  cl.onchange = () => { app.activeCats = [...cl.querySelectorAll('input:checked')].map(i => i.dataset.cat); saveLayers(); applyLayerVisibility(); };
  $('catAll').onclick = () => { cl.querySelectorAll('input').forEach(i => i.checked = true); cl.onchange(); };
  $('catNone').onclick = () => { cl.querySelectorAll('input').forEach(i => i.checked = false); cl.onchange(); };
  const sl = $('servList'); sl.innerHTML = '';
  for (const k in cfg.services) sl.insertAdjacentHTML('beforeend', `<label><input type="checkbox" data-s="${k}" ${app.activeServ.includes(k) ? 'checked' : ''}><span class="sw" style="background:${cfg.services[k].color};border-radius:50%"></span>${cfg.services[k].label}</label>`);
  sl.onchange = () => { app.activeServ = [...sl.querySelectorAll('input:checked')].map(i => i.dataset.s); saveLayers(); applyLayerVisibility(); };
  for (const id of ['lyArpa', 'lyComuni', 'lyConfine']) { if (st[id] !== undefined) $(id).checked = st[id]; $(id).onchange = () => { saveLayers(); applyLayerVisibility(); }; }
  $('basemap').onchange = () => { store.set('mzb_base', $('basemap').value); app.map.setStyle(styleFor($('basemap').value)); };
  app.wmsOn = st.wms || {};
  const wl = $('wmsList'), ov = app.manifest.overlays || [];
  wl.innerHTML = ov.length ? '' : '<span class="hint">Nessun servizio trovato nell\'ultimo calcolo.</span>';
  for (const o of ov) wl.insertAdjacentHTML('beforeend', `<label><input type="checkbox" data-w="wms-${o.service}" ${app.wmsOn['wms-' + o.service] ? 'checked' : ''}> ${o.title}</label>`);
  wl.onchange = () => { wl.querySelectorAll('input').forEach(i => { app.wmsOn[i.dataset.w] = i.checked; }); saveLayers(); applyLayerVisibility(); };
  $('wmsAdd').onclick = () => {
    const u = $('wmsUrl').value.trim(), l = $('wmsLayers').value.trim(); if (!u || !l) return;
    const o = { title: 'WMS: ' + l, service: 'custom' + Date.now(), wms: u.split('?')[0], layers: l };
    (app.customWms = app.customWms || []).push(o); app.wmsOn['wms-' + o.service] = true; addWms(o, true);
    wl.insertAdjacentHTML('beforeend', `<label><input type="checkbox" data-w="wms-${o.service}" checked> ${o.title}</label>`);
  };
}
function saveLayers() { store.set('mzb_layers', { cats: app.activeCats, serv: app.activeServ, lyArpa: $('lyArpa').checked, lyComuni: $('lyComuni').checked, lyConfine: $('lyConfine').checked, wms: app.wmsOn }); }
function applyLayerVisibility() {
  const map = app.map; if (!map.getLayer('fonti-fill')) return;
  const cf = ['in', ['get', 'cat'], ['literal', app.activeCats]];
  map.setFilter('fonti-fill', ['all', ['==', ['geometry-type'], 'Polygon'], cf]);
  map.setFilter('fonti-line', ['all', ['==', ['geometry-type'], 'Polygon'], cf]);
  map.setFilter('fonti-pt', ['all', ['==', ['geometry-type'], 'Point'], cf]);
  map.setFilter('servizi', ['in', ['get', 'type'], ['literal', app.activeServ]]);
  map.setLayoutProperty('servizi', 'visibility', app.activeServ.length ? 'visible' : 'none');
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  vis('arpa-pt', $('lyArpa').checked); vis('arpa-lab', $('lyArpa').checked);
  vis('comuni-fill', $('lyComuni').checked); vis('comuni-line', $('lyComuni').checked);
  vis('confine', $('lyConfine').checked);
  for (const id in (app.wmsOn || {})) vis(id, app.wmsOn[id]);
}
app.applyLayerVisibility = applyLayerVisibility;

boot();
