// Decodifica dei canali e formule dell'indice (condivise tra thread principale e worker).
// Deve combaciare con pipeline/raster.py.

export const TILE = 256, PX = TILE * TILE;

export function undelta(u8, C) {
  for (let c = 0; c < C; c++) {
    const base = c * PX;
    for (let r = 0; r < TILE; r++) {
      let o = base + r * TILE, acc = u8[o];
      for (let i = 1; i < TILE; i++) { acc = (acc + u8[o + i]) & 255; u8[o + i] = acc; }
    }
  }
  return u8;
}

export const decGroup = u => u / 51;
export const decFrac = u => u / 255;
export const decDist = (u, cap) => (u / 255) * (u / 255) * cap;

export function aqPenalty(pm25, no2, pm10) {
  return 0.35 * (0.5 * Math.max(0, pm25 - 5) / 5 + 0.3 * Math.max(0, no2 - 10) / 10 + 0.2 * Math.max(0, pm10 - 15) / 15);
}

export function defaultParams(cfg) {
  const groupW = {}, serviceW = {}, serviceD = {};
  for (const g in cfg.groups) groupW[g] = 1;
  for (const s in cfg.services) { serviceW[s] = cfg.services[s].w; serviceD[s] = [cfg.services[s].d0, cfg.services[s].d1]; }
  return {
    groupW, serviceW, serviceD, mit: cfg.scoring.mitigation, aqW: cfg.scoring.aq_weight, K: cfg.scoring.K, alpha: cfg.scoring.alpha,
    mode: 'comb', filter: { on: false, minComb: 0, minSal: 0, maxPm25: 40, maxDist: {}, minBigRoads: 0, minRail: 0 }, hideFail: true,
  };
}

// Prepara indici e tabelle per calcolare velocemente i pixel
export function buildModel(cfg, P) {
  const ch = {}; cfg.channels.forEach((c, i) => { ch[c.id] = i; });
  const cap = cfg.distCap;
  const groups = Object.keys(cfg.groups).map(g => ({ id: g, off: ch['g_' + g] * PX, w: P.groupW[g] ?? 1 }));
  let Ws = 0; for (const s in cfg.services) Ws += (P.serviceW[s] ?? 0);
  const services = Object.keys(cfg.services).map(s => {
    const [d0, d1] = P.serviceD[s] || [cfg.services[s].d0, cfg.services[s].d1];
    const lut = new Float32Array(256), w = Ws > 0 ? (P.serviceW[s] ?? 0) / Ws : 0;
    for (let u = 0; u < 256; u++) { const d = decDist(u, cap); lut[u] = w * (d <= d0 ? 1 : d >= d1 ? 0 : 1 - (d - d0) / (d1 - d0)); }
    return { id: s, off: ch['s_' + s] * PX, lut };
  });
  const distLut = new Float32Array(256); for (let u = 0; u < 256; u++) distLut[u] = decDist(u, cap);
  const F = P.filter || {};
  const fdist = [];
  if (F.on) for (const s in (F.maxDist || {})) if (F.maxDist[s] > 0 && ch['s_' + s] !== undefined) fdist.push({ off: ch['s_' + s] * PX, max: F.maxDist[s] });
  return {
    ch, cap, groups, services, distLut, P, fdist,
    vOff: ch.verde * PX, pm25: ch.pm25 * PX, no2: ch.no2 * PX, pm10: ch.pm10 * PX, valid: ch.valid * PX,
    big: ch.d_grandi_strade * PX, rail: ch.d_ferrovia * PX,
    gsel: P.mode.startsWith('g:') ? ch['g_' + P.mode.slice(2)] * PX : -1,
  };
}

// Restituisce [sal, serv(0..1), comb] per il pixel i di un tile decodificato
export function scorePixel(d, i, M, out) {
  const P = M.P;
  let src = 0;
  for (const g of M.groups) src += g.w * d[g.off + i] / 51;
  const verde = d[M.vOff + i] / 255;
  const bg = P.aqW * aqPenalty(d[M.pm25 + i] / 4, d[M.no2 + i] / 2, d[M.pm10 + i] / 2);
  const sal = 100 * Math.exp(-(bg + src * (1 - P.mit * verde)) / P.K);
  let sv = 0; for (const s of M.services) sv += s.lut[d[s.off + i]];
  out[0] = sal; out[1] = sv; out[2] = P.alpha * sal + (1 - P.alpha) * sv * 100;
  return out;
}

export function passFilter(d, i, M, sc) {
  const F = M.P.filter; if (!F || !F.on) return true;
  if (sc[2] < (F.minComb || 0) || sc[0] < (F.minSal || 0)) return false;
  if (F.maxPm25 && F.maxPm25 < 40 && d[M.pm25 + i] / 4 > F.maxPm25) return false;
  for (const f of M.fdist) if (M.distLut[d[f.off + i]] > f.max) return false;
  if (F.minBigRoads > 0 && M.distLut[d[M.big + i]] < F.minBigRoads) return false;
  if (F.minRail > 0 && M.distLut[d[M.rail + i]] < F.minRail) return false;
  return true;
}

// Rampe di colore
const SCORE_STOPS = [[0, [165, 0, 38]], [20, [215, 48, 39]], [40, [244, 109, 67]], [55, [253, 174, 97]], [65, [254, 224, 139]], [75, [166, 217, 106]], [85, [102, 189, 99]], [100, [26, 152, 80]]];
const AIR_STOPS = [[5, [26, 152, 80]], [10, [166, 217, 106]], [15, [254, 224, 139]], [20, [253, 174, 97]], [25, [244, 109, 67]], [35, [165, 0, 38]]];
function lut(stops, lo, hi, n = 256) {
  const t = new Uint8Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = lo + (hi - lo) * k / (n - 1); let c = stops[stops.length - 1][1];
    for (let j = 1; j < stops.length; j++) if (v <= stops[j][0]) { const [a, ca] = stops[j - 1], [b, cb] = stops[j], f = Math.max(0, (v - a) / (b - a)); c = ca.map((x, q) => x + (cb[q] - x) * f); break; }
    t[k * 3] = c[0]; t[k * 3 + 1] = c[1]; t[k * 3 + 2] = c[2];
  }
  return t;
}
export const SCORE_LUT = lut(SCORE_STOPS, 0, 100);
export const AIR_LUT = lut(AIR_STOPS, 0, 40);
export const SCORE_CSS = 'linear-gradient(90deg,' + SCORE_STOPS.map(([v, c]) => `rgb(${c}) ${v}%`).join(',') + ')';
export const AIR_CSS = 'linear-gradient(90deg,' + AIR_STOPS.map(([v, c]) => `rgb(${c}) ${v / 40 * 100}%`).join(',') + ')';
export function scoreColor(v) { const k = Math.max(0, Math.min(255, Math.round(v / 100 * 255))) * 3; return `rgb(${SCORE_LUT[k]},${SCORE_LUT[k + 1]},${SCORE_LUT[k + 2]})`; }
