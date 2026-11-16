"""Scrittura tile: archivio PMTiles multi-canale per i dati raster e PMTiles vettoriali (tippecanoe)."""
import json, math, os, shutil, subprocess, zlib
import numpy as np
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid, TileType, Compression

def _delta(block):
    """Filtro 'sub' per riga (come PNG): migliora molto la compressione di campi continui."""
    d = block.astype(np.int16)
    d[..., 1:] = d[..., 1:] - d[..., :-1]
    return (d & 0xFF).astype(np.uint8)

def _reduce(win, f, how):
    c, h, w = win.shape
    r = win.reshape(c, h // f, f, w // f, f)
    if how == "min":
        return r.min(axis=(2, 4))
    if how == "max":
        return r.max(axis=(2, 4))
    return np.rint(r.astype(np.float32).mean(axis=(2, 4))).astype(np.uint8)

def write_data_pmtiles(path, grid, chans, reducers, valid_idx, min_zoom, bbox, meta, log=print):
    """chans: array (C,H,W) uint8 sulla griglia z=grid.z. reducers: lista 'mean'|'min'|'max' per canale."""
    C = chans.shape[0]
    fill = np.array([255 if r == "min" else 0 for r in reducers], np.uint8)
    tiles = []
    level, gx0, gy0 = chans, grid.tx0 * 256, grid.ty0 * 256   # origine globale in pixel del livello corrente
    for z in range(grid.z, min_zoom - 1, -1):
        if z < grid.z:   # piramide: dimezza il livello precedente
            c_, h, w = level.shape
            ph, pw = h % 2, w % 2
            if ph or pw:
                pad = np.empty((c_, h + ph, w + pw), np.uint8); pad[:] = fill[:, None, None]; pad[:, :h, :w] = level; level = pad
            level = np.stack([_reduce(level[i:i + 1], 2, reducers[i])[0] for i in range(C)])
            gx0, gy0 = gx0 // 2, gy0 // 2
        H, W = level.shape[1:]
        cnt = 0
        for ty in range(gy0 // 256, (gy0 + H - 1) // 256 + 1):
            for tx in range(gx0 // 256, (gx0 + W - 1) // 256 + 1):
                X0, Y0 = tx * 256 - gx0, ty * 256 - gy0
                xa, ya = max(0, X0), max(0, Y0); xb, yb = min(W, X0 + 256), min(H, Y0 + 256)
                if xa >= xb or ya >= yb:
                    continue
                blk = np.empty((C, 256, 256), np.uint8); blk[:] = fill[:, None, None]
                blk[:, ya - Y0:yb - Y0, xa - X0:xb - X0] = level[:, ya:yb, xa:xb]
                if not blk[valid_idx].any():
                    continue
                tiles.append((zxy_to_tileid(z, tx, ty), zlib.compress(_delta(blk).tobytes(), 9)))
                cnt += 1
        log(f"    z{z}: {cnt} tile")
    tiles.sort(key=lambda t: t[0])
    with open(path, "wb") as fh:
        w = Writer(fh)
        for tid, data in tiles:
            w.write_tile(tid, data)
        w.finalize({
            "tile_type": TileType.UNKNOWN, "tile_compression": Compression.NONE,
            "min_lon_e7": int(bbox[0] * 1e7), "min_lat_e7": int(bbox[1] * 1e7),
            "max_lon_e7": int(bbox[2] * 1e7), "max_lat_e7": int(bbox[3] * 1e7),
            "center_zoom": 9, "center_lon_e7": int((bbox[0] + bbox[2]) / 2 * 1e7), "center_lat_e7": int((bbox[1] + bbox[3]) / 2 * 1e7),
        }, meta)
    size = os.path.getsize(path) / 1e6
    log(f"    archivio dati: {len(tiles)} tile, {size:.1f} MB")
    return size

def write_vector_pmtiles(path, layers, workdir, log=print):
    """layers: dict nome_layer -> lista di feature GeoJSON (dict). Richiede tippecanoe."""
    tc = shutil.which("tippecanoe") or os.environ.get("TIPPECANOE")
    if not tc:
        raise RuntimeError("tippecanoe non trovato")
    args = [tc, "-o", path, "--force", "-Z5", "-z14", "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
            "--no-tile-size-limit", "--simplification=4", "--detect-shared-borders", "-q"]
    for name, feats in layers.items():
        fp = os.path.join(workdir, f"{name}.geojsonl")
        with open(fp, "w") as f:
            for ft in feats:
                f.write(json.dumps(ft, ensure_ascii=False) + "\n")
        args += ["-L", json.dumps({"file": fp, "layer": name})]
    subprocess.run(args, check=True)
    log(f"    vettoriali: {os.path.getsize(path) / 1e6:.1f} MB")
