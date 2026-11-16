// Utilità geografiche
const RAD = Math.PI / 180;
export function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(a));
}
export function bearing(lat1, lon1, lat2, lon2) { // da 1 verso 2, gradi da nord in senso orario
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
export function lineLength(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += hav(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]); return s; }
export function ringArea(coords) { // m², formula sferica
  let a = 0; const n = coords.length; if (n < 3) return 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = coords[i], [x2, y2] = coords[(i + 1) % n]; a += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD)); }
  return Math.abs(a * 6378137 * 6378137 / 2);
}
export function pointInRing([x, y], ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; }
  return ins;
}
export const fmtM = d => d == null || !isFinite(d) ? '—' : d >= 15999 ? '> 16 km' : d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(d < 10000 ? 1 : 0).replace('.', ',') + ' km';
export const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

// indice spaziale semplice a griglia per punti [lat, lon, ...]
export class Bucket {
  constructor(items, latI, lonI, cell = 0.02) { this.c = cell; this.m = new Map(); this.latI = latI; this.lonI = lonI;
    for (const it of items) { const k = Math.floor(it[latI] / cell) + ':' + Math.floor(it[lonI] / cell); let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(it); } }
  near(lat, lon, radiusM) {
    const r = Math.ceil(radiusM / (this.c * 78000)) + 1, i0 = Math.floor(lat / this.c), j0 = Math.floor(lon / this.c), out = [];
    for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) { const a = this.m.get(i + ':' + j); if (a) out.push(...a); }
    return out;
  }
}
export function windFactor(p, theta) {
  const s = ((theta % 360) + 360) % 360 / 22.5, i = Math.floor(s) % 16, f = s - Math.floor(s);
  const v = p[i] * (1 - f) + p[(i + 1) % 16] * f;
  return Math.min(2.5, Math.max(0.5, 0.5 + 0.5 * v));
}
export function nearestWind(wind, lat, lon) {
  let best = null, bd = Infinity;
  for (const p of wind.points) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * 0.7) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
