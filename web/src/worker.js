// Worker: legge le tile multi-canale, ricalcola l'indice con i pesi correnti e produce immagini/campioni/statistiche.
import { PMTiles } from 'pmtiles';
import { undelta, buildModel, scorePixel, passFilter, SCORE_LUT, AIR_LUT, TILE, PX, decDist } from './codec.js';

let pm, cfg, P, M, C, zmin, zmax, version = 0;
const dataCache = new Map();      // "z/x/y" -> Uint8Array | null
const imgCache = new Map();       // "v/z/x/y" -> ImageBitmap (tile alla risoluzione dei dati, per overzoom)
const MAXD = 400, MAXI = 120;
let emptyPng;

function lruSet(map, k, v, max) { map.set(k, v); if (map.size > max) map.delete(map.keys().next().value); }

async function getData(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (dataCache.has(k)) { const v = dataCache.get(k); dataCache.delete(k); dataCache.set(k, v); return v; }
  let out = null;
  try {
    const r = await pm.getZxy(z, x, y);
    if (r && r.data) {
      const ds = new Blob([r.data]).stream().pipeThrough(new DecompressionStream('deflate'));
      out = undelta(new Uint8Array(await new Response(ds).arrayBuffer()), C);
    }
  } catch (e) { out = null; }
  lruSet(dataCache, k, out, MAXD);
  return out;
}

function paint(d) {
  const img = new ImageData(TILE, TILE), px = img.data, sc = [0, 0, 0];
  const mode = P.mode, hide = P.hideFail;
  for (let i = 0; i < PX; i++) {
    const o = i * 4;
    if (!d[M.valid + i]) { px[o + 3] = 0; continue; }
    scorePixel(d, i, M, sc);
    let k, lutT = SCORE_LUT, a = 255;
    if (mode === 'sal') k = sc[0] / 100;
    else if (mode === 'serv') k = sc[1];
    else if (mode === 'aria') { k = Math.min(1, d[M.pm25 + i] / 4 / 40); lutT = AIR_LUT; }
    else if (M.gsel >= 0) { const v = d[M.gsel + i] / 51; k = 1 - Math.min(1, v / 2); a = Math.min(255, Math.round(v / 1.5 * 255)); }
    else k = sc[2] / 100;
    const j = Math.max(0, Math.min(255, Math.round(k * 255))) * 3;
    px[o] = lutT[j]; px[o + 1] = lutT[j + 1]; px[o + 2] = lutT[j + 2]; px[o + 3] = a;
    if (P.filter && P.filter.on && !passFilter(d, i, M, sc)) {
      if (hide) px[o + 3] = 0; else { px[o] = px[o + 1] = px[o + 2] = 120; px[o + 3] = 90; }
    }
  }
  return img;
}

async function toPng(canvas) { const b = await canvas.convertToBlob({ type: 'image/png' }); return await b.arrayBuffer(); }

async function render(z, x, y) {
  if (z < zmin) return emptyPng.slice(0);
  if (z <= zmax) {
    const d = await getData(z, x, y);
    if (!d) return emptyPng.slice(0);
    const c = new OffscreenCanvas(TILE, TILE); c.getContext('2d').putImageData(paint(d), 0, 0);
    return toPng(c);
  }
  // overzoom: dipinge il tile padre alla risoluzione dei dati e lo ingrandisce con interpolazione
  const k = z - zmax, f = 1 << k, px = x >> k, py = y >> k;
  const ik = `${version}/${zmax}/${px}/${py}`;
  let bmp = imgCache.get(ik);
  if (!bmp) {
    const d = await getData(zmax, px, py);
    if (!d) return emptyPng.slice(0);
    const c0 = new OffscreenCanvas(TILE, TILE); c0.getContext('2d').putImageData(paint(d), 0, 0);
    bmp = c0.transferToImageBitmap(); lruSet(imgCache, ik, bmp, MAXI);
  }
  const s = TILE / f, sx = (x - px * f) * s, sy = (y - py * f) * s;
  const c = new OffscreenCanvas(TILE, TILE), g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx, sy, s, s, 0, 0, TILE, TILE);
  return toPng(c);
}

// --- coordinate ---
function lngLatToPixel(lng, lat, z) {
  const n = TILE * 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

async function sample(lng, lat) {
  const z = zmax, [X, Y] = lngLatToPixel(lng, lat, z);
  const tx = Math.floor(X / TILE), ty = Math.floor(Y / TILE);
  const d = await getData(z, tx, ty);
  if (!d) return null;
  const i = Math.min(TILE - 1, Math.floor(Y - ty * TILE)) * TILE + Math.min(TILE - 1, Math.floor(X - tx * TILE));
  if (!d[M.valid + i]) return null;
  const sc = scorePixel(d, i, M, [0, 0, 0]), out = { sal: sc[0], serv: sc[1] * 100, comb: sc[2], groups: {}, dist: {}, pass: passFilter(d, i, M, sc) };
  for (const g of M.groups) out.groups[g.id] = d[g.off + i] / 51;
  out.verde = d[M.vOff + i] / 255; out.pm25 = d[M.pm25 + i] / 4; out.no2 = d[M.no2 + i] / 2; out.pm10 = d[M.pm10 + i] / 2;
  for (const s of M.services) out.dist[s.id] = decDist(d[s.off + i], M.cap);
  out.bigRoads = decDist(d[M.big + i], M.cap); out.rail = decDist(d[M.rail + i], M.cap);
  return out;
}

async function stats(ring) {
  // sceglie lo zoom in modo da non leggere troppe tile
  let minx = 180, miny = 90, maxx = -180, maxy = -90;
  for (const [x, y] of ring) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  let z = zmax, a, b;
  for (; z > zmin; z--) { a = lngLatToPixel(minx, maxy, z); b = lngLatToPixel(maxx, miny, z); if ((Math.floor(b[0] / TILE) - Math.floor(a[0] / TILE) + 1) * (Math.floor(b[1] / TILE) - Math.floor(a[1] / TILE) + 1) <= 64) break; }
  a = lngLatToPixel(minx, maxy, z); b = lngLatToPixel(maxx, miny, z);
  const pr = ring.map(([x, y]) => lngLatToPixel(x, y, z));
  const hist = new Array(10).fill(0); let n = 0, pass = 0, sS = 0, sC = 0, sV = 0, sPm = 0, sNo2 = 0, sG = 0, mn = 100, mx = 0;
  const groupSum = {}; for (const g of M.groups) groupSum[g.id] = 0;
  const sc = [0, 0, 0];
  for (let ty = Math.floor(a[1] / TILE); ty <= Math.floor(b[1] / TILE); ty++) for (let tx = Math.floor(a[0] / TILE); tx <= Math.floor(b[0] / TILE); tx++) {
    const d = await getData(z, tx, ty); if (!d) continue;
    for (let r = 0; r < TILE; r++) {
      const Y = ty * TILE + r + 0.5; if (Y < a[1] - 1 || Y > b[1] + 1) continue;
      const xs = [];
      for (let p = 0, q = pr.length - 1; p < pr.length; q = p++) { const [x1, y1] = pr[p], [x2, y2] = pr[q]; if ((y1 > Y) !== (y2 > Y)) xs.push(x1 + (Y - y1) * (x2 - x1) / (y2 - y1)); }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - tx * TILE - 0.5)), c1 = Math.min(TILE - 1, Math.floor(xs[k + 1] - tx * TILE - 0.5));
        for (let c = c0; c <= c1; c++) {
          const i = r * TILE + c; if (!d[M.valid + i]) continue;
          scorePixel(d, i, M, sc); n++;
          sS += sc[0]; sV += sc[1] * 100; sC += sc[2]; mn = Math.min(mn, sc[2]); mx = Math.max(mx, sc[2]);
          hist[Math.min(9, Math.floor(sc[2] / 10))]++;
          if (passFilter(d, i, M, sc)) pass++;
          sPm += d[M.pm25 + i] / 4; sNo2 += d[M.no2 + i] / 2; sG += d[M.vOff + i] / 255;
          for (const g of M.groups) groupSum[g.id] += g.w * d[g.off + i] / 51;
        }
      }
    }
  }
  if (!n) return null;
  for (const g in groupSum) groupSum[g] /= n;
  return { n, zoom: z, sal: sS / n, serv: sV / n, comb: sC / n, min: mn, max: mx, hist, passPct: pass / n * 100, pm25: sPm / n, no2: sNo2 / n, verde: sG / n * 100, groups: groupSum };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') {
      cfg = e.data.cfg; P = e.data.params; C = cfg.channels.length; [zmin, zmax] = cfg.dataZoom;
      pm = new PMTiles(e.data.url); M = buildModel(cfg, P);
      const c = new OffscreenCanvas(1, 1); c.getContext('2d'); emptyPng = await toPng(c);
      self.postMessage({ id, ok: true });
    } else if (type === 'params') {
      P = e.data.params; M = buildModel(cfg, P); version++; imgCache.clear();
      self.postMessage({ id, ok: true });
    } else if (type === 'render') {
      const buf = await render(e.data.z, e.data.x, e.data.y);
      self.postMessage({ id, ok: true, buf }, [buf]);
    } else if (type === 'sample') {
      self.postMessage({ id, ok: true, res: await sample(e.data.lng, e.data.lat) });
    } else if (type === 'stats') {
      self.postMessage({ id, ok: true, res: await stats(e.data.ring) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
