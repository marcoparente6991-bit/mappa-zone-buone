// Classifica dei comuni
import { esc } from './geo.js';
import { scoreColor } from './codec.js';

export async function initComuni(app) {
  let data = [];
  try { data = await app.load('comuni.json'); } catch { app.$('comList').innerHTML = '<p class="hint">Classifica non disponibile.</p>'; return; }
  const render = () => {
    const q = app.$('comQ').value.trim().toLowerCase(), k = app.$('comSort').value, dir = app.$('comDir').value === 'asc' ? 1 : -1;
    const rows = data.map((c, i) => ({ ...c, i })).sort((a, b) => dir * (a[k] - b[k]));
    rows.forEach((r, i) => r.rank = i + 1);
    const vis = q ? rows.filter(r => r.nome.toLowerCase().includes(q)) : rows;
    app.$('comList').innerHTML = `<div class="c h"><span>#</span><span>Comune (${data.length})</span><span class="v">Ind.</span><span class="v">Sal.</span><span class="v">Serv.</span></div>`
      + vis.slice(0, 400).map(r => `<div class="c" data-i="${r.i}"><span class="hint">${r.rank}</span><span>${esc(r.nome)}</span><span class="v" style="color:${scoreColor(r.comb)};font-weight:700">${r.comb.toFixed(0)}</span><span class="v">${r.sal.toFixed(0)}</span><span class="v">${r.serv.toFixed(0)}</span></div>`).join('')
      + (vis.length > 400 ? `<p class="hint">… altri ${vis.length - 400}: usa la ricerca.</p>` : '');
    app.$('comList').querySelectorAll('.c[data-i]').forEach(el => el.onclick = () => {
      const c = data[+el.dataset.i], b = c.bbox;
      app.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 14 });
      if (app.map.getLayer('comuni-hl')) app.map.setFilter('comuni-hl', ['==', ['get', 'istat'], c.istat]);
      app.toast(`${c.nome}: indice ${c.comb.toFixed(0)} · salubrità ${c.sal.toFixed(0)} · servizi ${c.serv.toFixed(0)}`, 4000);
    });
  };
  for (const id of ['comQ', 'comSort', 'comDir']) app.$(id).addEventListener('input', render);
  render();
}
