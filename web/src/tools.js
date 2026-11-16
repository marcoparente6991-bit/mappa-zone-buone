// Strumenti: misura distanza/area, analisi di un'area disegnata, filtro delle zone
import { lineLength, ringArea, pointInRing, fmtM, esc } from './geo.js';
import { scoreColor } from './codec.js';

let app, pts = [], hover = null;

export function addDrawLayers(a) {
  const map = a.map; if (map.getSource('draw')) return;
  map.addSource('draw', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#1a7f5a', 'fill-opacity': .12 } });
  map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#1a7f5a', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'draw-pt', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#fff', 'circle-stroke-color': '#1a7f5a', 'circle-stroke-width': 2 } });
}

function draw() {
  const c = hover ? [...pts, hover] : pts, f = c.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p } }));
  if (c.length >= 2) f.push({ type: 'Feature', geometry: app.tool !== 'dist' && c.length >= 3 ? { type: 'Polygon', coordinates: [[...c, c[0]]] } : { type: 'LineString', coordinates: c } });
  const s = app.map.getSource('draw'); if (s) s.setData({ type: 'FeatureCollection', features: f });
  const out = app.$('toolOut');
  if (app.tool === 'dist' && c.length >= 2) out.innerHTML = `<div class="kpi"><b>${fmtM(lineLength(c))}</b><span>distanza</span></div>`;
  if (app.tool === 'area' && c.length >= 3) { const a = ringArea(c); out.innerHTML = `<div class="kpis"><div class="kpi"><b>${a > 1e6 ? (a / 1e6).toFixed(2).replace('.', ',') + ' km²' : (a / 1e4).toFixed(2).replace('.', ',') + ' ha'}</b><span>area</span></div><div class="kpi"><b>${fmtM(lineLength([...c, c[0]]))}</b><span>perimetro</span></div></div>`; }
}

function start(tool) {
  stop(true); app.tool = tool; pts = [];
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  app.map.getCanvas().style.cursor = 'crosshair'; app.map.doubleClickZoom.disable();
  app.$('toolOut').innerHTML = ''; app.toast(tool === 'dist' ? 'Clicca i punti del percorso, doppio clic per finire' : 'Disegna l\'area: doppio clic per chiudere');
}
function stop(keep) {
  app.tool = null; hover = null;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('on'));
  if (app.map) { app.map.getCanvas().style.cursor = ''; setTimeout(() => app.map.doubleClickZoom.enable(), 300); }
  if (!keep) { pts = []; draw(); app.$('toolOut').innerHTML = ''; }
}
async function finish() {
  const tool = app.tool; hover = null;
  if (tool === 'stats' && pts.length >= 3) { const ring = pts.slice(); stop(true); draw(); await analyse(ring); return; }
  stop(true); draw();
}

async function analyse(ring) {
  const out = app.$('toolOut'); out.innerHTML = '<p class="hint">Analisi in corso…</p>';
  const r = (await app.call('stats', { ring })).res;
  if (!r) { out.innerHTML = '<p class="hint">Area fuori dai dati.</p>'; return; }
  const cfg = app.cfg, a = ringArea(ring);
  const [fonti, serv] = await Promise.all([app.load('fonti_index.json'), app.load('servizi_index.json')]);
  const cnt = {}, scnt = {};
  for (const it of fonti.items) if (pointInRing([it[2], it[1]], ring)) { const c = fonti.cats[it[0]]; cnt[c] = (cnt[c] || 0) + 1; }
  for (const it of serv.items) if (pointInRing([it[2], it[1]], ring)) { const t = serv.types[it[0]]; scnt[t] = (scnt[t] || 0) + 1; }
  const hm = Math.max(...r.hist, 1);
  let h = `<div class="kpis"><div class="kpi"><b style="color:${scoreColor(r.comb)}">${r.comb.toFixed(0)}</b><span>indice medio</span></div><div class="kpi"><b>${r.sal.toFixed(0)}</b><span>salubrità</span></div><div class="kpi"><b>${r.serv.toFixed(0)}</b><span>servizi</span></div></div>`;
  h += `<div class="hint">Area ${(a / 1e6).toFixed(2).replace('.', ',')} km² · indice da ${r.min.toFixed(0)} a ${r.max.toFixed(0)}${app.params.filter.on ? ` · <b>${r.passPct.toFixed(0)}%</b> dell'area rispetta il filtro` : ''}</div>`;
  h += '<div class="hist">' + r.hist.map((v, i) => `<i title="${i * 10}–${i * 10 + 10}: ${(v / r.n * 100).toFixed(0)}%" style="height:${v / hm * 100}%;background:${scoreColor(i * 10 + 5)}"></i>`).join('') + '</div><div class="ends hint" style="display:flex;justify-content:space-between"><span>0</span><span>distribuzione dell\'indice</span><span>100</span></div>';
  h += `<table><tr><td>PM2.5 · NO₂ medi</td><td class="r">${r.pm25.toFixed(1)} · ${r.no2.toFixed(0)} µg/m³</td></tr><tr><td>Verde/acqua medio</td><td class="r">${r.verde.toFixed(0)}%</td></tr></table>`;
  h += '<h3>Pressioni medie</h3><div class="bars">' + Object.entries(r.groups).filter(([, v]) => v > 0.005).sort((x, y) => y[1] - x[1]).map(([g, v]) => `<div class="b"><span>${cfg.groups[g].label}</span><span class="t"><i style="width:${Math.min(100, v / 1.5 * 100)}%;background:${cfg.groups[g].color}"></i></span><span class="r hint">${v.toFixed(2)}</span></div>`).join('') + '</div>';
  const cl = Object.entries(cnt).sort((x, y) => y[1] - x[1]);
  h += '<h3>Fonti dentro l\'area</h3>' + (cl.length ? '<table>' + cl.map(([c, n]) => `<tr><td><span class="sw" style="display:inline-block;vertical-align:-2px;background:${cfg.categories[c].color}"></span> ${cfg.categories[c].label}</td><td class="r">${n}</td></tr>`).join('') + '</table>' : '<p class="hint">Nessuna.</p>');
  h += '<h3>Servizi dentro l\'area</h3><table>' + Object.keys(cfg.services).map(k => `<tr><td>${cfg.services[k].label}</td><td class="r">${scnt[k] || 0}</td></tr>`).join('') + '</table>';
  out.innerHTML = h;
}

function buildFilter() {
  const F = app.params.filter, cfg = app.cfg;
  const set = () => { app.$('filterBox').classList.toggle('dim', !F.on); app.setParams({ filter: F }); };
  const bind = (id, key, fmt) => { const el = app.$(id), o = app.$(id + 'V'); el.value = F[key] ?? el.value; o.textContent = fmt(+el.value);
    el.oninput = () => { F[key] = +el.value; o.textContent = fmt(+el.value); set(); }; };
  app.$('fOn').checked = !!F.on; app.$('filterBox').classList.toggle('dim', !F.on);
  app.$('fOn').onchange = () => { F.on = app.$('fOn').checked; set(); };
  bind('fComb', 'minComb', v => v || '—'); bind('fSal', 'minSal', v => v || '—'); bind('fPm', 'maxPm25', v => v >= 40 ? '—' : v + ' µg/m³');
  bind('fBig', 'minBigRoads', v => v ? v + ' m' : '—'); bind('fRail', 'minRail', v => v ? v + ' m' : '—');
  const box = app.$('fServ'); box.innerHTML = ''; F.maxDist = F.maxDist || {};
  for (const k of ['stazione', 'fermata', 'scuola', 'supermercato', 'farmacia', 'ospedale']) {
    if (!cfg.services[k]) continue;
    const max = k === 'ospedale' ? 10000 : k === 'stazione' ? 5000 : 3000;
    const d = document.createElement('div'); d.className = 'field';
    d.innerHTML = `<label>${esc(cfg.services[k].label)} entro <b></b></label><input type="range" min="0" max="${max}" step="${max / 50}">`;
    const r = d.querySelector('input'), b = d.querySelector('b'); r.value = F.maxDist[k] || 0; b.textContent = r.value > 0 ? fmtM(+r.value) : '—';
    r.oninput = () => { F.maxDist[k] = +r.value; b.textContent = r.value > 0 ? fmtM(+r.value) : '—'; set(); };
    box.appendChild(d);
  }
  app.$('fHide').checked = app.params.hideFail !== false;
  app.$('fHide').onchange = () => app.setParams({ hideFail: app.$('fHide').checked });
}

export function initTools(a) {
  app = a;
  document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => (app.tool === b.dataset.tool ? stop() : start(b.dataset.tool)));
  app.$('toolClear').onclick = () => stop();
  const map = app.map;
  map.on('click', e => { if (!app.tool) return; pts.push([e.lngLat.lng, e.lngLat.lat]); draw(); });
  map.on('dblclick', e => { if (!app.tool) return; e.preventDefault(); if (pts.length > 1) pts.pop(); finish(); });
  map.on('mousemove', e => { if (!app.tool || !pts.length) return; hover = [e.lngLat.lng, e.lngLat.lat]; draw(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && app.tool) stop(); if (e.key === 'Enter' && app.tool) finish(); });
  buildFilter();
}
