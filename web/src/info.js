// Pannello informazioni: dati usati, metodo, limiti
import { esc } from './geo.js';

export function renderInfo(app) {
  const m = app.manifest || {}, cfg = app.cfg;
  let h = `<h3>Aggiornamento</h3><p>Dati calcolati il <b>${esc(m.built || cfg.built || '—')}</b>. Il calcolo si ripete in automatico ogni mese.</p>`;
  h += '<h3>Dati usati</h3><table>' + (m.datasets || []).map(d => `<tr><td><b>${esc(d.nome)}</b><br><span class="hint">${esc(d.dettaglio || '')}</span></td><td class="r"><span class="tag" style="${d.stato === 'ok' ? 'background:#e8f5e9;color:#1b5e20' : 'background:#fff3e0;color:#b45309'}">${esc(d.stato)}</span></td></tr>`).join('') + '</table>';
  if ((m.warnings || []).length) h += '<h3>Avvisi</h3><ul>' + m.warnings.map(w => `<li class="hint">${esc(w)}</li>`).join('') + '</ul>';
  h += `<h3>Come si calcola</h3>
  <p><b>Fonti di pressione</b>: per ogni categoria l'impatto è pieno dentro il perimetro e decresce come (1 − d/R)² fino al raggio R. Per le fonti che inquinano l'aria il raggio si allunga sottovento (fino a ×2,5) e si accorcia sopravento, in base alla rosa dei venti locale degli ultimi 12 mesi. Più fonti vicine della stessa categoria aumentano l'impatto (effetto distretto).</p>
  <p><b>Meteo</b>: molte ore di calma di vento (tipiche della Pianura Padana) aumentano l'impatto degli inquinanti aerodispersi; più pioggia lo riduce leggermente.</p>
  <p><b>Aria di fondo</b>: PM2.5, PM10 e NO₂ medi annui dal modello europeo CAMS, corretti localmente con le centraline ARPA, confrontati con le linee guida OMS 2021 (5 / 15 / 10 µg/m³).</p>
  <p><b>Verde e acqua</b> nei ~300 m riducono l'impatto delle fonti fino alla percentuale di mitigazione scelta.</p>
  <p><b>Salubrità</b> = 100 · e<sup>−(fondo + Σ peso·pressione · (1 − mitigazione·verde)) / ${cfg.scoring.K}</sup>. <b>Servizi</b> = media pesata della vicinanza a ciascun servizio (pieno entro la distanza ideale, nullo oltre la massima). <b>Indice combinato</b> = media pesata dei due.</p>
  <h3>Raggi delle categorie</h3><table>${Object.values(cfg.categories).map(c => `<tr><td><span class="sw" style="display:inline-block;vertical-align:-2px;background:${c.color}"></span> ${esc(c.label)}</td><td class="r">${c.R} m · peso ${c.w}</td></tr>`).join('')}</table>
  <p class="hint">Raggi e pesi delle singole categorie si cambiano in <code>pipeline/config.yaml</code> sul repository, poi si rilancia il calcolo.</p>
  <h3>Limiti</h3>
  <p class="hint">OpenStreetMap non è completo: impianti autorizzati, roghi, data center in progetto e contaminazioni di falda possono mancare (si aggiungono come GeoJSON in <code>pipeline/extra/</code>). La risoluzione di calcolo è ~50 m. L'indice è uno strumento di screening, non una valutazione sanitaria o una perizia: per un acquisto verifica PGT, zonizzazione acustica comunale, anagrafe dei siti contaminati e dati ARPA.</p>
  <h3>Crediti</h3><p class="hint">© OpenStreetMap contributors (ODbL) · OpenFreeMap · Esri World Imagery · Open-Meteo (CC BY 4.0) · Copernicus Atmosphere Monitoring Service · Regione Lombardia e ARPA Lombardia (open data) · Photon/Komoot per la ricerca indirizzi.</p>`;
  app.$('infoBox').innerHTML = h;
}
