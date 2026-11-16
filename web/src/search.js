// Ricerca indirizzi (Photon/OSM, senza chiave; ripiego su Nominatim)
import { esc } from './geo.js';

export function initSearch(app) {
  const q = app.$('q'), box = app.$('qres');
  let t, ctl;
  const B = app.cfg.bounds;
  async function run() {
    const s = q.value.trim(); if (s.length < 3) { box.innerHTML = ''; return; }
    ctl && ctl.abort(); ctl = new AbortController();
    let items = [];
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(s)}&limit=7&bbox=${B[0]},${B[1]},${B[2]},${B[3]}`, { signal: ctl.signal }).then(r => r.json());
      items = (r.features || []).map(f => { const p = f.properties;
        return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], t: [p.name, [p.street, p.housenumber].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || p.city,
          sub: [p.postcode, p.city || p.town || p.village, p.county].filter(Boolean).join(' '), ext: p.extent }; });
    } catch (e) {
      if (e.name === 'AbortError') return;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=it&viewbox=${B[0]},${B[3]},${B[2]},${B[1]}&bounded=1&q=${encodeURIComponent(s)}`).then(r => r.json());
        items = r.map(x => ({ lon: +x.lon, lat: +x.lat, t: x.display_name.split(',').slice(0, 2).join(','), sub: x.display_name.split(',').slice(2, 4).join(',') }));
      } catch { }
    }
    box.innerHTML = items.map((it, i) => `<div data-i="${i}">${esc(it.t)}<br><small>${esc(it.sub)}</small></div>`).join('') || '<div><small>Nessun risultato in Lombardia</small></div>';
    box.querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
      const it = items[+el.dataset.i]; box.innerHTML = ''; q.value = it.t;
      if (it.ext) app.map.fitBounds([[it.ext[0], it.ext[3]], [it.ext[2], it.ext[1]]], { padding: 60, maxZoom: 16 });
      else app.map.flyTo({ center: [it.lon, it.lat], zoom: 16 });
      app.openCard({ lng: it.lon, lat: it.lat });
    });
  }
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 280); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { const f = box.querySelector('[data-i]'); f && f.click(); } if (e.key === 'Escape') box.innerHTML = ''; });
}
