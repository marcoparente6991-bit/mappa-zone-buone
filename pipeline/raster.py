"""Calcolo raster delle componenti su griglia Web Mercator allineata alle tile."""
import math
import numpy as np
import shapely
from scipy import ndimage
from scipy.spatial import cKDTree
from scipy.interpolate import RegularGridInterpolator
from rasterio import features
from affine import Affine

R = 6378137.0
C = 2 * math.pi * R
COARSE = 16  # fattore della griglia grossolana per vento/meteo/aria

def lonlat_to_merc(lon, lat):
    lat = np.clip(lat, -85, 85)
    return R * np.radians(lon), R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))

def to_merc(geom):
    return shapely.transform(geom, lambda xy: np.column_stack(lonlat_to_merc(xy[:, 0], xy[:, 1])))


class Grid:
    def __init__(self, bbox, z):
        n = 256 * 2 ** z
        self.z, self.n = z, n
        px = lambda lon: (lon + 180) / 360 * n
        py = lambda lat: (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
        self.tx0, self.tx1 = int(px(bbox[0]) // 256), int(px(bbox[2]) // 256)
        self.ty0, self.ty1 = int(py(bbox[3]) // 256), int(py(bbox[1]) // 256)
        self.W = (self.tx1 - self.tx0 + 1) * 256
        self.H = (self.ty1 - self.ty0 + 1) * 256
        self.res = C / n
        self.ox = -C / 2 + self.tx0 * 256 * self.res
        self.oy = C / 2 - self.ty0 * 256 * self.res
        self.transform = Affine(self.res, 0, self.ox, 0, -self.res, self.oy)
        ym = self.oy - (np.arange(self.H) + 0.5) * self.res
        self.lat_rows = np.degrees(np.arctan(np.sinh(ym / R)))
        self.lon_cols = np.degrees((self.ox + (np.arange(self.W) + 0.5) * self.res) / R)
        self.mpp = (self.res * np.cos(np.radians(self.lat_rows))).astype(np.float32)  # metri reali per pixel, per riga
        self.mpp_min = float(self.mpp.min())

    def zeros(self, dtype=np.float32):
        return np.zeros((self.H, self.W), dtype)

    def rasterize(self, geoms_merc, burn=1, all_touched=True, dtype=np.uint8, out=None):
        shapes = [(g, burn) for g in geoms_merc if g is not None and not g.is_empty]
        if out is None:
            out = self.zeros(dtype)
        if shapes:
            features.rasterize(shapes, out=out, transform=self.transform, all_touched=all_touched, merge_alg=features.MergeAlg.replace)
        return out


class WindField:
    """Rosa dei venti per regione (punto della griglia meteo più vicino) e fattore meteo."""
    def __init__(self, grid, wind):
        pts = wind["points"]
        self.P = np.array([p["p"] for p in pts], dtype=np.float32)          # (N,16) verso cui soffia
        calm = np.array([p["calm"] for p in pts], dtype=np.float32)
        rain = np.array([p["rain"] for p in pts], dtype=np.float32)
        a = np.clip(1 + 0.6 * (calm - 0.35), 0.8, 1.3)
        b = np.clip(1 - 0.15 * (rain - 900) / 400, 0.85, 1.15)
        self.metp = a * b
        lo = np.array([p["lon"] for p in pts]); la = np.array([p["lat"] for p in pts])
        k = math.cos(math.radians(float(np.mean(la))))
        tree = cKDTree(np.column_stack([lo * k, la]))
        cl = grid.lon_cols[COARSE // 2::COARSE]; rl = grid.lat_rows[COARSE // 2::COARSE]
        LO, LA = np.meshgrid(cl, rl)
        _, idx = tree.query(np.column_stack([LO.ravel() * k, LA.ravel()]))
        self.region = idx.reshape(LA.shape).astype(np.int32)
        self.met_coarse = self.metp[self.region]

    def met_at(self, ys, xs):
        return self.met_coarse[np.minimum(ys // COARSE, self.region.shape[0] - 1), np.minimum(xs // COARSE, self.region.shape[1] - 1)]

    def factor(self, ys, xs, theta):
        reg = self.region[np.minimum(ys // COARSE, self.region.shape[0] - 1), np.minimum(xs // COARSE, self.region.shape[1] - 1)]
        s = (theta % 360) / 22.5
        i = np.floor(s).astype(np.int32) % 16; f = (s - np.floor(s)).astype(np.float32)
        p = self.P[reg, i] * (1 - f) + self.P[reg, (i + 1) % 16] * f
        return np.clip(0.5 + 0.5 * p, 0.5, 2.5)


def category_impact(grid, mask, Rm, w, mode, line, wind, density=True):
    """Impatto di una categoria: (1 − d/R_eff)² dalla fonte più vicina, R_eff allungato sottovento."""
    if not mask.any():
        return None
    aniso = (mode == "air") and not line
    reach = Rm * (2.5 if aniso else 1.0)
    rp = int(math.ceil(reach / grid.mpp_min)) + 2
    ys, xs = np.nonzero(mask)
    y0, y1 = max(0, ys.min() - rp), min(grid.H, ys.max() + rp + 1)
    x0, x1 = max(0, xs.min() - rp), min(grid.W, xs.max() + rp + 1)
    m = mask[y0:y1, x0:x1]
    d, inds = ndimage.distance_transform_edt(~m, return_indices=True)
    dm = (d * grid.mpp[y0:y1, None]).astype(np.float32)
    sel = dm < reach
    yy, xx = np.nonzero(sel)
    dsel = dm[sel]
    if aniso:
        sy = inds[0][sel]; sx = inds[1][sel]
        theta = np.degrees(np.arctan2(xx - sx, sy - yy))  # 0 = nord, senso orario (direzione sorgente → cella)
        Re = Rm * wind.factor(yy + y0, xx + x0, theta)
    else:
        Re = Rm
    t = np.clip(1 - dsel / Re, 0, 1)
    v = (w * t * t).astype(np.float32)
    if density and not line:
        k = max(3, int(2 * Rm / grid.mpp_min) | 1)
        frac = ndimage.uniform_filter(m.astype(np.float32), size=k, mode="constant")
        v *= 1 + 0.6 * np.clip(frac[sel] / 0.3, 0, 1)
    if mode == "air":
        v *= wind.met_at(yy + y0, xx + x0)
    out = grid.zeros()
    out[yy + y0, xx + x0] = v
    return out


def distance_m(grid, mask, cap=16000.0):
    if not mask.any():
        return np.full((grid.H, grid.W), cap, np.float32)
    d = ndimage.distance_transform_edt(~mask)
    return np.minimum(d * grid.mpp[:, None], cap).astype(np.float32)


def green_fraction(grid, green_mask, radius_m):
    k = max(3, int(2 * radius_m / grid.mpp_min) | 1)
    return ndimage.uniform_filter(green_mask.astype(np.float32), size=k, mode="nearest")


def aq_fields(grid, aq, stations=None, log=print):
    """Interpola CAMS sulla griglia (grossolana → piena) e corregge con i residui delle centraline ARPA."""
    out = {}
    cl = grid.lon_cols[COARSE // 2::COARSE]; rl = grid.lat_rows[COARSE // 2::COARSE]
    LA, LO = np.meshgrid(rl, cl, indexing="ij")
    for k in ("pm25", "no2", "pm10"):
        F = np.array(aq[k], dtype=float)
        if np.isnan(F).all():
            out[k] = None; continue
        F = np.where(np.isnan(F), np.nanmean(F), F)
        itp = RegularGridInterpolator((aq["lats"], aq["lons"]), F, bounds_error=False, fill_value=None)
        coarse = itp(np.column_stack([LA.ravel(), LO.ravel()])).reshape(LA.shape)
        if stations:
            obs = [(s["lon"], s["lat"], s[k]) for s in stations if k in s]
            if len(obs) >= 3:
                o = np.array(obs)
                model = itp(np.column_stack([o[:, 1], o[:, 0]]))
                resid = o[:, 2] - model
                kx = math.cos(math.radians(45.5))
                tree = cKDTree(np.column_stack([o[:, 0] * kx, o[:, 1]]))
                dd, ii = tree.query(np.column_stack([LO.ravel() * kx, LA.ravel()]), k=min(6, len(o)))
                dkm = dd * 111.0
                wgt = 1 / (dkm ** 2 + 4)
                corr = (wgt * resid[ii]).sum(1) / wgt.sum(1)
                fade = np.exp(-(dkm.min(1) / 15.0) ** 2)  # la correzione svanisce oltre ~15–25 km
                coarse = coarse + (corr * fade).reshape(LA.shape)
                log(f"    {k}: corretto con {len(o)} centraline ARPA (residuo medio {resid.mean():+.1f} µg/m³)")
        coarse = np.clip(coarse, 0, None).astype(np.float32)
        out[k] = ndimage.zoom(coarse, (grid.H / coarse.shape[0], grid.W / coarse.shape[1]), order=1)[:grid.H, :grid.W]
    return out


def aq_penalty(pm25, no2, pm10):
    return 0.35 * (0.5 * np.maximum(0, pm25 - 5) / 5 + 0.3 * np.maximum(0, no2 - 10) / 10 + 0.2 * np.maximum(0, pm10 - 15) / 15)


# ---------- codifica in byte (deve combaciare con web/src/codec.js) ----------
DIST_CAP = 16000.0
def enc_group(v): return np.clip(np.rint(v * 51), 0, 255).astype(np.uint8)
def enc_frac(v): return np.clip(np.rint(v * 255), 0, 255).astype(np.uint8)
def enc_conc(v, s): return np.clip(np.rint(v * s), 0, 255).astype(np.uint8)
def enc_dist(d): return np.clip(np.rint(np.sqrt(np.clip(d, 0, DIST_CAP) / DIST_CAP) * 255), 0, 255).astype(np.uint8)
def dec_group(u): return u.astype(np.float32) / 51
def dec_dist(u): return (u.astype(np.float32) / 255) ** 2 * DIST_CAP
