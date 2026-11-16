// Immobili salvati, confronto e stampa
import { fmtM, esc } from './geo.js';
import { scoreColor } from './codec.js';

let app, list = [], results = new Map(), resVer = -1;

const save = () => app.store.set('mzb_props', list);

export function addPropsLayer(a) {
  const map = a.map;
  if (map.getSource('props')) return;
  map.addSource('props', { type: 'geojson', data: geo() });
  map.addLayer({ id: 'props-pt', type: 'circle', source: 'props', paint: { 'circle-radius': 11, 'circle-color': '#111', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'props-lab', type: 'symbol', source: 'props', layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Bold', 'Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': true, 'icon-allow-overlap': true }, paint: { 'text-color': '#fff' } });
}
function geo() { return { type: 'FeatureCollection', features: list.map((p, i) => ({ type: 'Feature', properties: { n: String(i + 1) }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) }; }
function syncLayer() { const s = app.map && app.map.getSource('props'); if (s) s.setData(geo()); }

async function evalAll() {
  if (resVer !== app.ver) { results.clear(); resVer = app.ver; }
  await Promise.all(list.map(async p => { if (!results.has(p.id)) results.set(p.id, await app.evaluate(p.lat, p.lon)); }));
}

export async function refreshProps() {
  const box = app.$('propList');
  if (!list.length) { box.innerHTML = '<p class="hint">Nessun immobile salvato.</p>'; syncLayer(); return; }
  await evalAll();
  box.innerHTML = list.map((p, i) => {
    const r = results.get(p.id), s = r && r.s, v = s ? s.comb : null;
    return `<div class="prop" data-i="${i}"><div class="sc" style="background:${v == null ? '#999' : scoreColor(v)}">${v == null ? '—' : v.toFixed(0)}</div>
      <div><b>${i + 1}.</b> <input value="${esc(p.name)}" data-f="name" placeholder="Nome"><div class="hint">${esc(p.addr || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`)}</div>
      <div class="meta"><input value="${esc(p.price || '')}" data-f="price" placeholder="Prezzo €" type="number"><input value="${esc(p.mq || '')}" data-f="mq" placeholder="m²" type="number"></div>
      <input value="${esc(p.note || '')}" data-f="note" placeholder="Note"></div>
      <div style="display:flex;flex-direction:column;gap:4px"><button class="btn ghost sm" data-a="go">⌖</button><button class="btn ghost sm" data-a="del">✕</button></div></div>`;
  }).join('');
  box.querySelectorAll('.prop').forEach(el => {
    const p = list[+el.dataset.i];
    el.querySelectorAll('input').forEach(inp => inp.onchange = () => { p[inp.dataset.f] = inp.value; save(); });
    el.querySelector('[data-a=go]').onclick = () => { app.map.flyTo({ center: [p.lon, p.lat], zoom: 15 }); app.openCard({ lng: p.lon, lat: p.lat }); };
    el.querySelector('[data-a=del]').onclick = () => { list.splice(+el.dataset.i, 1); save(); refreshProps(); };
  });
  syncLayer();
}

function addProp(p) {
  list.push({ id: 'p' + Date.now(), name: p.name || `Immobile ${list.length + 1}`, addr: p.addr || '', lat: p.lat, lon: p.lon, price: p.price || '', mq: p.mq || '', note: p.note || '' });
  save(); refreshProps(); app.toast('Immobile salvato (scheda «Immobili»)');
}

async function openCompare() {
  if (!list.length) { app.toast('Salva prima almeno un immobile'); return; }
  await evalAll();
  const cfg = app.cfg, R = list.map(p => results.get(p.id));
  const rows = [
    ['Indice combinato', r => r.s && r.s.comb, 'max', v => v.toFixed(0)],
    ['Salubrità', r => r.s && r.s.sal, 'max', v => v.toFixed(0)],
    ['Servizi', r => r.s && r.s.serv, 'max', v => v.toFixed(0)],
    ['PM2.5 (µg/m³)', r => r.s && r.s.pm25, 'min', v => v.toFixed(1)],
    ['NO₂ (µg/m³)', r => r.s && r.s.no2, 'min', v => v.toFixed(0)],
    ['Verde/acqua ~300 m', r => r.s && r.s.verde * 100, 'max', v => v.toFixed(0) + '%'],
    ['Autostrade/superstrade', r => r.s && r.s.bigRoads, 'max', fmtM],
    ['Ferrovia', r => r.s && r.s.rail, 'max', fmtM],
    ...Object.keys(cfg.services).map(k => [cfg.services[k].label, r => r.nearest[k] ? r.nearest[k].d : r.s && r.s.dist[k], 'min', fmtM]),
  ];
  let h = `<img id="cmpMap" style="width:100%;max-height:340px;object-fit:cover;border-radius:10px;border:1px solid var(--line)"><table><tr><th></th>${list.map((p, i) => `<th>${i + 1}. ${esc(p.name)}<br><span class="hint">${esc(p.addr || '')}</span></th>`).join('')}</tr>`;
  h += `<tr><td>Prezzo</td>${list.map(p => `<td>${p.price ? Number(p.price).toLocaleString('it-IT') + ' €' : '—'}</td>`).join('')}</tr>`;
  h += `<tr><td>€/m²</td>${list.map(p => `<td>${p.price && p.mq ? Math.round(p.price / p.mq).toLocaleString('it-IT') + ' €' : '—'}</td>`).join('')}</tr>`;
  for (const [lab, get, best, fmt] of rows) {
    const vals = R.map(r => r ? get(r) : null), ok = vals.filter(v => v != null);
    const b = ok.length > 1 ? (best === 'max' ? Math.max(...ok) : Math.min(...ok)) : null;
    h += `<tr><td>${lab}</td>${vals.map(v => `<td class="${v != null && v === b ? 'best' : ''}">${v == null ? '—' : fmt(v)}</td>`).join('')}</tr>`;
  }
  h += `<tr><td>Fonti principali</td>${R.map(r => `<td class="hint">${r && r.pressures.length ? r.pressures.slice(0, 5).map(p => `${esc(p.name || cfg.categories[p.cat].label)} (${p.d < 1 ? 'dentro' : fmtM(p.d)})`).join('<br>') : 'nessuna'}</td>`).join('')}</tr>`;
  h += `<tr><td>Note</td>${list.map(p => `<td>${esc(p.note || '')}</td>`).join('')}</tr></table>`;
  h += `<p class="hint">Pesi correnti: salubrità ${Math.round(app.params.alpha * 100)}% nel combinato. Dati aggiornati al ${esc(app.cfg.built)}. L'indice è uno strumento di screening, non una perizia ambientale.</p>`;
  app.$('cmpBody').innerHTML = h; app.$('cmp').classList.remove('hidden');
  // istantanea della mappa con gli immobili numerati
  const map = app.map, lons = list.map(p => p.lon), lats = list.map(p => p.lat);
  if (list.length === 1) map.jumpTo({ center: [lons[0], lats[0]], zoom: 14 });
  else map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 15, duration: 0 });
  map.once('idle', () => { try { app.$('cmpMap').src = map.getCanvas().toDataURL('image/png'); } catch { } });
}

function toCsv() {
  const head = ['nome', 'indirizzo', 'lat', 'lon', 'prezzo', 'mq', 'note', 'indice', 'salubrita', 'servizi', 'pm25'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(';')].concat(list.map(p => { const r = results.get(p.id), s = r && r.s;
    return [p.name, p.addr, p.lat, p.lon, p.price, p.mq, p.note, s ? s.comb.toFixed(1) : '', s ? s.sal.toFixed(1) : '', s ? s.serv.toFixed(1) : '', s ? s.pm25.toFixed(1) : ''].map(q).join(';'); }));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' })); a.download = 'immobili_zone_buone.csv'; a.click();
}
function fromCsv(text) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map(l => l.split(';').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"')));
  const h = rows.shift().map(x => x.toLowerCase()); let n = 0;
  for (const r of rows) { const o = Object.fromEntries(h.map((k, i) => [k, r[i]])); const lat = parseFloat(o.lat), lon = parseFloat(o.lon);
    if (isFinite(lat) && isFinite(lon)) { list.push({ id: 'p' + Date.now() + n++, name: o.nome || '', addr: o.indirizzo || '', lat, lon, price: o.prezzo || '', mq: o.mq || '', note: o.note || '' }); } }
  save(); refreshProps(); app.toast(`${n} immobili importati`);
}

export function initProps(a) {
  app = a; list = app.store.get('mzb_props', []); app.addProp = addProp;
  app.$('cmpOpen').onclick = openCompare;
  app.$('cmpX').onclick = () => app.$('cmp').classList.add('hidden');
  app.$('cmpPrint').onclick = () => window.print();
  app.$('propCsv').onclick = async () => { await evalAll(); toCsv(); };
  app.$('propImp').onchange = async e => { const f = e.target.files[0]; if (f) fromCsv(await f.text()); e.target.value = ''; };
  refreshProps();
}
