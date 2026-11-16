// Scheda di valutazione di un punto
import { hav, bearing, fmtM, DIRS, Bucket, windFactor, nearestWind, esc } from './geo.js';
import { scoreColor } from './codec.js';

let app, marker, state = null, idx = null;

async function indexes() {
  if (idx) return idx;
  const [fonti, serv, wind] = await Promise.all([app.load('fonti_index.json'), app.load('servizi_index.json'), app.load('vento.json')]);
  idx = { fonti, serv, wind, fb: new Bucket(fonti.items, 1, 2, 0.05), sb: new Bucket(serv.items, 1, 2, 0.02) };
  return idx;
}

export async function evaluate(lat, lon) {
  const [s, I] = await Promise.all([app.call('sample', { lng: lon, lat }).then(r => r.res), indexes()]);
  const cfg = app.cfg, P = app.params, w = nearestWind(I.wind, lat, lon);
  const press = new Map();
  for (const it of I.fb.near(lat, lon, 11000)) {
    const [ci, la, lo, req, wm, name, si] = it, cat = I.fonti.cats[ci], c = cfg.categories[cat];
    if (!c) continue;
    const d = Math.max(0, hav(la, lo, lat, lon) - req);
    const aniso = c.mode === 'air' && !c.line;
    const F = aniso && w ? windFactor(w.p, bearing(la, lo, lat, lon)) : 1;
    const Re = c.R * F; if (d >= Re) continue;
    const v = c.w * wm * (1 - d / Re) ** 2 * (P.groupW[c.group] ?? 1);
    if (v <= 0.001) continue;
    const key = cat + '|' + (name || la.toFixed(3) + lo.toFixed(3));
    const prev = press.get(key);
    if (!prev || prev.v < v) press.set(key, { cat, name, d, v, F, src: I.fonti.srcs[si] });
  }
  const pressures = [...press.values()].sort((a, b) => b.v - a.v).slice(0, 12);
  const nearest = {};
  for (const it of I.sb.near(lat, lon, 3000)) {
    const [ti, la, lo, name] = it, t = I.serv.types[ti], d = hav(la, lo, lat, lon);
    if (!nearest[t] || d < nearest[t].d) nearest[t] = { d, name };
  }
  return { s, pressures, nearest, wind: w };
}

function setMarker(lngLat) {
  if (!marker) { const el = document.createElement('div'); el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#111;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5)'; marker = new app.maplibregl.Marker({ element: el }); }
  marker.setLngLat(lngLat).addTo(app.map);
}

export function openCard(lngLat, feature) { state = { lngLat, feature, addr: null }; setMarker(lngLat); render(); reverse(); }
export function refreshCard() { if (state) render(); }

async function reverse() {
  const st = state;
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${st.lngLat.lng}&lat=${st.lngLat.lat}&limit=1`).then(r => r.json());
    const p = (r.features && r.features[0] || {}).properties || {};
    st.addr = [[p.street, p.housenumber].filter(Boolean).join(' ') || p.name, p.city || p.town || p.village || p.county].filter(Boolean).join(', ');
  } catch { st.addr = ''; }
  if (st === state) render();
}

async function render() {
  const st = state, body = app.$('cardBody'), card = app.$('card');
  card.classList.remove('hidden');
  if (!st._r) body.innerHTML = '<p class="hint">Calcolo…</p>';
  const { lat, lng } = st.lngLat;
  const r = await evaluate(lat, lng); if (st !== state) return; st._r = r;
  const cfg = app.cfg, s = r.s;
  let h = '';
  if (st.feature) {
    const p = st.feature.properties || {}, lid = st.feature.layer.id;
    const what = lid.startsWith('fonti') ? (cfg.categories[p.cat] || {}).label : lid === 'servizi' ? (cfg.services[p.type] || {}).label : 'Centralina ARPA';
    h += `<div class="tag">${esc(what)}</div> <b>${esc(p.name || '')}</b>${p.src ? ` <span class="hint">· ${esc(p.src)}</span>` : ''}`;
    if (lid === 'arpa-pt') h += `<div class="hint">Medie ultimi 12 mesi: PM2.5 ${p.pm25 ?? '—'} · PM10 ${p.pm10 ?? '—'} · NO₂ ${p.no2 ?? '—'} µg/m³</div>`;
    h += '<hr style="border:0;border-top:1px solid var(--line);margin:10px 0">';
  }
  h += `<div class="hint">${esc(st.addr || '')}${st.addr ? '<br>' : ''}${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
  if (!s) { body.innerHTML = h + '<p>Punto fuori dall\'area analizzata (Lombardia).</p>'; return; }
  h += `<div style="display:flex;align-items:baseline;gap:10px;margin-top:8px"><span class="big" style="color:${scoreColor(s.comb)}">${s.comb.toFixed(0)}</span><span>Indice combinato<br><span class="hint">su 100</span></span>
    ${app.params.filter.on ? `<span class="tag" style="margin-left:auto;${s.pass ? 'background:#e8f5e9;color:#1b5e20' : 'background:#fdecea;color:#b71c1c'}">${s.pass ? 'rispetta il filtro' : 'escluso dal filtro'}</span>` : ''}</div>`;
  h += `<div class="kpis"><div class="kpi"><b style="color:${scoreColor(s.sal)}">${s.sal.toFixed(0)}</b><span>Salubrità</span></div><div class="kpi"><b style="color:${scoreColor(s.serv)}">${s.serv.toFixed(0)}</b><span>Servizi</span></div><div class="kpi"><b>${Math.round(s.verde * 100)}%</b><span>Verde/acqua ~300 m</span></div></div>`;
  h += `<table><tr><td>PM2.5 · PM10 · NO₂ (media annua)</td><td class="r">${s.pm25.toFixed(1)} · ${s.pm10.toFixed(0)} · ${s.no2.toFixed(0)} µg/m³</td></tr>
        <tr><td>Autostrade/superstrade</td><td class="r">${fmtM(s.bigRoads)}</td></tr><tr><td>Ferrovia</td><td class="r">${fmtM(s.rail)}</td></tr>`;
  if (r.wind) h += `<tr><td>Vento prevalente · calme</td><td class="r">da ${DIRS[Math.round(r.wind.prev_from / 22.5) % 16]} · ${Math.round(r.wind.calm * 100)}%</td></tr>`;
  h += '</table>';
  // composizione
  const P = app.params, rows = [];
  for (const g in cfg.groups) rows.push({ l: cfg.groups[g].label, c: cfg.groups[g].color, v: (P.groupW[g] ?? 1) * s.groups[g] * (1 - P.mit * s.verde) });
  const bg = P.aqW * 0.35 * (0.5 * Math.max(0, s.pm25 - 5) / 5 + 0.3 * Math.max(0, s.no2 - 10) / 10 + 0.2 * Math.max(0, s.pm10 - 15) / 15);
  rows.push({ l: 'Inquinamento di fondo dell\'aria', c: '#9e9e9e', v: bg });
  const mx = Math.max(1, ...rows.map(r => r.v));
  h += '<h3>Da cosa dipende la salubrità</h3><div class="bars">' + rows.filter(r => r.v > 0.005).sort((a, b) => b.v - a.v).map(r => `<div class="b"><span>${r.l}</span><span class="t"><i style="width:${r.v / mx * 100}%;background:${r.c}"></i></span><span class="r hint">${r.v.toFixed(2)}</span></div>`).join('') + '</div>';
  h += '<h3>Fonti che incidono qui</h3>';
  h += r.pressures.length ? '<table>' + r.pressures.map(p => `<tr><td><span class="sw" style="display:inline-block;vertical-align:-2px;background:${cfg.categories[p.cat].color}"></span> ${esc(p.name || cfg.categories[p.cat].label)}<br><span class="hint">${cfg.categories[p.cat].label}${p.F > 1.2 ? ' · <span class="tag wind">sottovento</span>' : p.F < 0.8 ? ' · sopravento' : ''}</span></td><td class="r">${p.d < 1 ? 'dentro' : fmtM(p.d)}</td></tr>`).join('') + '</table>'
    : '<p class="hint">Nessuna fonte puntuale entro il suo raggio d\'impatto (strade e aria di fondo sono comunque nel calcolo).</p>';
  h += '<h3>Servizi più vicini</h3><table>' + Object.keys(cfg.services).map(k => { const n = r.nearest[k], d = n ? n.d : s.dist[k];
    return `<tr><td>${cfg.services[k].label}${n && n.name ? `<br><span class="hint">${esc(n.name)}</span>` : ''}</td><td class="r">${fmtM(d)}</td></tr>`; }).join('') + '</table>';
  h += `<div class="row gap wrap" style="margin-top:12px"><button class="btn" id="cSave">Salva immobile</button><button class="btn ghost" id="cCopy">Copia</button>
    <a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}">Street View</a></div>`;
  body.innerHTML = h;
  app.$('cSave').onclick = () => app.addProp({ lat, lon: lng, addr: st.addr || '' });
  app.$('cCopy').onclick = () => {
    const t = `${st.addr || ''} (${lat.toFixed(5)}, ${lng.toFixed(5)})\nIndice ${s.comb.toFixed(0)} · Salubrità ${s.sal.toFixed(0)} · Servizi ${s.serv.toFixed(0)} · PM2.5 ${s.pm25.toFixed(1)}\n`
      + 'Fonti: ' + (r.pressures.map(p => `${p.name || cfg.categories[p.cat].label} ${p.d < 1 ? 'dentro' : fmtM(p.d)}`).join('; ') || 'nessuna') + '\n'
      + 'Servizi: ' + Object.keys(cfg.services).map(k => `${cfg.services[k].label} ${fmtM(r.nearest[k] ? r.nearest[k].d : s.dist[k])}`).join('; ');
    navigator.clipboard.writeText(t).then(() => app.toast('Scheda copiata')).catch(() => app.toast('Copia non consentita dal browser'));
  };
}

export function initCard(a) {
  app = a;
  app.$('cardX').onclick = () => { app.$('card').classList.add('hidden'); state = null; marker && marker.remove(); };
  app.openCard = openCard; app.evaluate = evaluate;
}
