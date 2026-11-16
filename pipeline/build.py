#!/usr/bin/env python3
"""Pipeline "Mappa zone buone": scarica i dati, calcola le componenti e scrive i file per la web app.

Uso:
  python pipeline/build.py                      # build completo (rete necessaria)
  python pipeline/build.py --pbf file.osm.pbf --offline --bbox 9.0,45.35,9.4,45.6   # test locale
"""
import argparse, datetime, glob, json, math, os, sys, time
import numpy as np
import yaml
import shapely
from shapely.geometry import shape, mapping, box, Point
from shapely.prepared import prep

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import osm_extract, official, weather, raster, tiles  # noqa: E402

CAT_COLORS = {
    "industria": "#8e44ad", "logistica": "#d35400", "acciaieria": "#b71c1c", "raffineria": "#4a148c", "chimico": "#c2185b",
    "inceneritore": "#e65100", "centrale": "#f9a825", "bitume": "#212121", "rifiuti": "#6d4c41", "discarica": "#4e342e",
    "cava": "#a1887f", "datacenter": "#263238", "datacenter_progetto": "#546e7a", "contaminato": "#880e4f", "pfas": "#0277bd",
    "aeroporto": "#1565c0", "aviosuperficie": "#64b5f6", "ferrovia": "#455a64", "autostrada": "#d32f2f", "superstrada": "#e53935",
    "primaria": "#fb8c00", "secondaria": "#fdd835", "terziaria": "#fff176",
}
T0 = time.time()
def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)

def ramp(d, d0, d1):
    return np.clip(1 - (d - d0) / max(1.0, d1 - d0), 0, 1)

def r_eq(g):
    """raggio equivalente (m) di una geometria lon/lat"""
    if g.geom_type in ("Polygon", "MultiPolygon"):
        c = g.centroid; k = 111320 * math.cos(math.radians(c.y))
        return math.sqrt(max(g.area * k * 110540, 1) / math.pi)
    return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.yaml"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "web", "public", "data"))
    ap.add_argument("--work", default=os.path.join(HERE, "..", ".cache"))
    ap.add_argument("--pbf", help="file .osm.pbf locale (salta il download)")
    ap.add_argument("--bbox", help="riquadro lon_min,lat_min,lon_max,lat_max (test)")
    ap.add_argument("--offline", action="store_true", help="niente rete: meteo/aria sintetici, niente dati ufficiali")
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config))
    os.makedirs(args.out, exist_ok=True); os.makedirs(args.work, exist_ok=True)
    cats, groups, servs, sc = cfg["categories"], cfg["groups"], cfg["services"], cfg["scoring"]
    bbox = [float(v) for v in args.bbox.split(",")] if args.bbox else cfg["region"]["bbox"]
    mg = cfg["region"]["margin_deg"]
    ext = [bbox[0] - mg, bbox[1] - mg, bbox[2] + mg, bbox[3] + mg]
    manifest = {"built": datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"), "datasets": [], "warnings": [], "overlays": []}

    # ---------------- 1. OpenStreetMap ----------------
    log("1/7 OpenStreetMap")
    pbf = osm_extract.prepare_pbf(cfg["osm_pbf"], ext, args.work, args.pbf, log)
    osm = osm_extract.extract(pbf, log)
    region = None
    if not args.bbox:
        cand = [a for a in osm["admin"] if a["level"] == 4 and a["name"] == cfg["region"]["osm_admin_name"]]
        if cand:
            region = cand[0]["geom"]; bbox = list(region.bounds)
    if region is None:
        region = box(*bbox)
        if not args.bbox:
            manifest["warnings"].append("Confine regionale non trovato in OSM: uso il riquadro.")
    region_prep = prep(region)
    comuni = [a for a in osm["admin"] if a["level"] == 8 and region_prep.contains(a["geom"].representative_point())]
    manifest["datasets"].append({"nome": "OpenStreetMap", "dettaglio": f"{len(osm['sources'])} fonti, {len(osm['roads'])} tratti stradali, {len(osm['services'])} servizi, {len(comuni)} comuni", "stato": "ok"})

    # ---------------- 2. Siti curati e dati utente ----------------
    log("2/7 Siti curati e dati aggiuntivi (pipeline/extra)")
    extra = []
    files = [os.path.join(HERE, "curated_sites.geojson")] + sorted(glob.glob(os.path.join(HERE, "extra", "*.geojson")))
    for fp in files:
        gj = json.load(open(fp))
        for f in gj.get("features", []):
            p = f.get("properties") or {}
            if p.get("categoria") not in cats or not f.get("geometry"):
                continue
            extra.append({"geom": shape(f["geometry"]), "cat": p["categoria"], "name": p.get("nome", ""), "wMul": float(p.get("peso", 1)),
                          "r0": float(p.get("raggio", 100)), "src": p.get("fonte") or os.path.basename(fp)})
    log(f"    {len(extra)} siti da file")

    # ---------------- 3. Dati ufficiali ----------------
    off = []; stations = []
    if not args.offline:
        log("3/7 Dati ufficiali")
        oc = cfg["official"]
        try:
            feats, used = official.fetch_contaminated(oc, log)
            off += feats
            manifest["datasets"].append({"nome": "Siti contaminati – Regione Lombardia (AGISCO)", "dettaglio": "; ".join(f"{u['layer']}: {u['count']}" for u in used) or "nessun layer", "stato": "ok" if feats else "vuoto"})
        except Exception as e:
            manifest["datasets"].append({"nome": "Siti contaminati – Regione Lombardia (AGISCO)", "stato": "non raggiungibile", "dettaglio": str(e)[:200]})
        try:
            found = official.discover_services(oc, log)
            feats, overlays, used = official.fetch_discovered(oc, found, log)
            off += feats; manifest["overlays"] += overlays
            for u in used:
                manifest["datasets"].append({"nome": u["servizio"], "dettaglio": f"{u['count']} elementi come «{cats[u['categoria']]['label']}»", "stato": "ok"})
        except Exception as e:
            manifest["warnings"].append(f"Ricerca servizi regionali non riuscita: {str(e)[:200]}")
        try:
            stations = official.fetch_arpa(oc, cfg["weather"]["days"], log)
            manifest["datasets"].append({"nome": "Centraline ARPA Lombardia", "dettaglio": f"{len(stations)} stazioni, medie ultimi 12 mesi", "stato": "ok"})
        except Exception as e:
            manifest["datasets"].append({"nome": "Centraline ARPA Lombardia", "stato": "non raggiungibile", "dettaglio": str(e)[:200]})
    else:
        log("3/7 Dati ufficiali: saltati (offline)")
    off = [f for f in off if box(*ext).intersects(f["geom"])]

    # ---------------- 4. Meteo e aria ----------------
    log("4/7 Vento, piogge e qualità dell'aria")
    wb = [bbox[0] - 0.25, bbox[1] - 0.25, bbox[2] + 0.25, bbox[3] + 0.25]
    weather.CALLS_PER_HOUR = cfg["weather"].get("openmeteo_calls_per_hour", 4000)
    if args.offline:
        wind = weather.synthetic_wind(wb, cfg["weather"]["wind_grid_step_deg"]); aq = weather.synthetic_aq(wb, cfg["weather"]["aq_grid_step_deg"])
    else:
        try:
            wind = weather.fetch_wind(wb, cfg["weather"]["wind_grid_step_deg"], cfg["weather"]["days"], log)
        except Exception as e:
            manifest["warnings"].append(f"Vento non disponibile ({str(e)[:120]}): uso valori neutri"); wind = weather.synthetic_wind(wb, 1.0)
            for p in wind["points"]: p["p"] = [1.0] * 16; p["calm"] = 0.35; p["rain"] = 900
        try:
            aq = weather.fetch_aq(wb, cfg["weather"]["aq_grid_step_deg"], cfg["weather"]["days"], log)
        except Exception as e:
            manifest["warnings"].append(f"Qualità dell'aria CAMS non disponibile: {str(e)[:120]}"); aq = None
    manifest["datasets"].append({"nome": "Vento e piogge", "dettaglio": f"{wind['source']}, {len(wind['points'])} punti, periodo {' → '.join(x for x in wind['period'] if x)}", "stato": "ok"})
    if aq is not None:
        manifest["datasets"].append({"nome": "Qualità dell'aria di fondo", "dettaglio": f"{aq['source']}, periodo {' → '.join(x for x in aq['period'] if x)}" + (", corretta con centraline ARPA" if stations else ""), "stato": "ok"})

    # ---------------- 5. Raster ----------------
    log("5/7 Calcolo delle componenti")
    gb = [bbox[0] - 0.02, bbox[1] - 0.02, bbox[2] + 0.02, bbox[3] + 0.02]
    G = raster.Grid(gb, cfg["grid_zoom"])
    log(f"    griglia {G.W}×{G.H} px (~{G.mpp.mean():.0f} m), tile z{G.z} x{G.tx0}-{G.tx1} y{G.ty0}-{G.ty1}")
    WF = raster.WindField(G, wind)
    group_ids = list(groups.keys()); serv_ids = list(servs.keys())
    channels = ([{"id": f"g_{g}", "kind": "group", "reduce": "mean"} for g in group_ids]
                + [{"id": "verde", "kind": "frac", "reduce": "mean"}]
                + [{"id": "pm25", "kind": "conc", "scale": 4, "reduce": "mean"}, {"id": "no2", "kind": "conc", "scale": 2, "reduce": "mean"},
                   {"id": "pm10", "kind": "conc", "scale": 2, "reduce": "mean"}]
                + [{"id": f"s_{s}", "kind": "dist", "reduce": "min"} for s in serv_ids]
                + [{"id": "d_grandi_strade", "kind": "dist", "reduce": "min"}, {"id": "d_ferrovia", "kind": "dist", "reduce": "min"},
                   {"id": "valid", "kind": "mask", "reduce": "max"}])
    CI = {c["id"]: i for i, c in enumerate(channels)}
    chans = np.zeros((len(channels), G.H, G.W), np.uint8)

    def merc_geom(f, default_r0=50.0):
        g = raster.to_merc(f["geom"])
        if f["geom"].geom_type in ("Point", "MultiPoint", "LineString", "MultiLineString"):
            r0 = f.get("r0", default_r0) if f["geom"].geom_type.endswith("Point") else 20.0
            g = g.buffer(r0 / math.cos(math.radians(f["geom"].centroid.y)))
        return g

    all_src = ([dict(s, src="OpenStreetMap") for s in osm["sources"]] + [dict(f) for f in extra] + off)
    by_cat = {}
    for f in all_src:
        by_cat.setdefault(f["cat"], []).append(f)
    lines_by_cat = {}
    for f in osm["roads"] + osm["rail"]:
        lines_by_cat.setdefault(f["cat"], []).append(f)

    counts = {}
    for g in group_ids:
        acc = G.zeros()
        for ck, c in cats.items():
            if c["group"] != g:
                continue
            best = None
            if c.get("line"):
                feats = lines_by_cat.get(ck, [])
                counts[ck] = len(feats)
                if feats:
                    mask = G.rasterize([raster.to_merc(f["geom"]) for f in feats]).astype(bool)
                    best = raster.category_impact(G, mask, c["R"], c["w"], c["mode"], True, WF)
            else:
                feats = by_cat.get(ck, [])
                counts[ck] = len(feats)
                for wm in sorted({f.get("wMul", 1.0) for f in feats}):
                    sub = [f for f in feats if f.get("wMul", 1.0) == wm]
                    mask = G.rasterize([merc_geom(f) for f in sub]).astype(bool)
                    imp = raster.category_impact(G, mask, c["R"], c["w"] * wm, c["mode"], False, WF)
                    if imp is not None:
                        best = imp if best is None else np.maximum(best, imp)
            if best is not None:
                cap = 1.5 * c["w"]
                acc += cap * (1 - np.exp(-best / cap))
            log(f"    {ck}: {counts[ck]} elementi")
        chans[CI[f"g_{g}"]] = raster.enc_group(acc)
        del acc

    big = [f for f in lines_by_cat.get("autostrada", []) + lines_by_cat.get("superstrada", [])]
    chans[CI["d_grandi_strade"]] = raster.enc_dist(raster.distance_m(G, G.rasterize([raster.to_merc(f["geom"]) for f in big]).astype(bool)))
    chans[CI["d_ferrovia"]] = raster.enc_dist(raster.distance_m(G, G.rasterize([raster.to_merc(f["geom"]) for f in osm["rail"]]).astype(bool)))

    gm = G.rasterize([raster.to_merc(f["geom"]) for f in osm["greens"]], all_touched=False)
    G.rasterize([raster.to_merc(f["geom"]).buffer(30) for f in osm["rivers"]], out=gm)
    chans[CI["verde"]] = raster.enc_frac(raster.green_fraction(G, gm.astype(bool), sc["green_radius_m"]))
    del gm
    log("    verde e acque: fatto")

    svc_by = {}
    for s in osm["services"]:
        svc_by.setdefault(s["type"], []).append(s)
    for s in serv_ids:
        pts = svc_by.get(s, [])
        m = np.zeros((G.H, G.W), bool)
        if pts:
            x, y = raster.lonlat_to_merc(np.array([p["lon"] for p in pts]), np.array([p["lat"] for p in pts]))
            cx = ((x - G.ox) / G.res).astype(int); cy = ((G.oy - y) / G.res).astype(int)
            ok = (cx >= 0) & (cy >= 0) & (cx < G.W) & (cy < G.H)
            m[cy[ok], cx[ok]] = True
        chans[CI[f"s_{s}"]] = raster.enc_dist(raster.distance_m(G, m))
        log(f"    servizi {s}: {len(pts)}")

    if aq is not None:
        A = raster.aq_fields(G, aq, stations, log)
        if A["pm25"] is not None: chans[CI["pm25"]] = raster.enc_conc(A["pm25"], 4)
        if A["no2"] is not None: chans[CI["no2"]] = raster.enc_conc(A["no2"], 2)
        if A["pm10"] is not None: chans[CI["pm10"]] = raster.enc_conc(A["pm10"], 2)
        del A
    valid = G.rasterize([raster.to_merc(region)], all_touched=True)
    chans[CI["valid"]] = valid * 255
    del valid

    # ---------------- 6. Statistiche per comune (pesi predefiniti) ----------------
    log("6/7 Statistiche per comune")
    def default_scores(r0, r1):
        sl = slice(r0, r1)
        src = sum(raster.dec_group(chans[CI[f"g_{g}"], sl]) for g in group_ids)
        verde = chans[CI["verde"], sl].astype(np.float32) / 255
        bg = sc["aq_weight"] * raster.aq_penalty(chans[CI["pm25"], sl] / 4.0, chans[CI["no2"], sl] / 2.0, chans[CI["pm10"], sl] / 2.0)
        sal = 100 * np.exp(-(bg + src * (1 - sc["mitigation"] * verde)) / sc["K"])
        W = sum(v["w"] for v in servs.values())
        sv = sum(servs[s]["w"] * ramp(raster.dec_dist(chans[CI[f"s_{s}"], sl]), servs[s]["d0"], servs[s]["d1"]) for s in serv_ids) / W * 100
        return sal, sv
    ids = np.zeros((G.H, G.W), np.int32)
    shapes = [(raster.to_merc(c["geom"]), i + 1) for i, c in enumerate(comuni)]
    if shapes:
        from rasterio import features as rf
        rf.rasterize(shapes, out=ids, transform=G.transform, all_touched=False)
    nC = len(comuni) + 1
    s_sal = np.zeros(nC); s_sv = np.zeros(nC); s_n = np.zeros(nC)
    step = 512
    for r0 in range(0, G.H, step):
        r1 = min(G.H, r0 + step)
        sal, sv = default_scores(r0, r1)
        lab = ids[r0:r1].ravel()
        s_sal += np.bincount(lab, sal.ravel(), nC); s_sv += np.bincount(lab, sv.ravel(), nC); s_n += np.bincount(lab, minlength=nC)
    com_out = []
    for i, c in enumerate(comuni):
        n = s_n[i + 1]
        if n == 0:
            continue
        sal, sv = s_sal[i + 1] / n, s_sv[i + 1] / n
        b = c["geom"].bounds
        com_out.append({"nome": c["name"], "istat": c["istat"], "sal": round(sal, 1), "serv": round(sv, 1),
                        "comb": round(sc["alpha"] * sal + (1 - sc["alpha"]) * sv, 1), "bbox": [round(v, 4) for v in b]})
    com_out.sort(key=lambda r: -r["comb"])
    log(f"    {len(com_out)} comuni")

    # ---------------- 7. Scrittura file ----------------
    log("7/7 Scrittura tile e indici")
    reducers = [c["reduce"] for c in channels]
    size = tiles.write_data_pmtiles(os.path.join(args.out, "dati.pmtiles"), G, chans, reducers, CI["valid"], cfg["data_min_zoom"], bbox,
                                    {"channels": [c["id"] for c in channels]}, log)
    del chans

    def simp(g, tol=0.00005):
        return g.simplify(tol, preserve_topology=True)
    vf = []
    for f in all_src:
        if not box(*ext).intersects(f["geom"]):
            continue
        g = f["geom"]
        if g.geom_type.endswith("Point") and f.get("r0", 0) > 150:
            g = Point(g.x, g.y).buffer(f["r0"] / 111320 / math.cos(math.radians(g.y)), 24) if g.geom_type == "Point" else g
        vf.append({"type": "Feature", "properties": {"cat": f["cat"], "name": f.get("name", ""), "src": f.get("src", "")}, "geometry": mapping(simp(g))})
    sv_feats = [{"type": "Feature", "tippecanoe": {"minzoom": 12 if s["type"] == "fermata" else 10},
                 "properties": {"type": s["type"], "name": s["name"]}, "geometry": {"type": "Point", "coordinates": [round(s["lon"], 6), round(s["lat"], 6)]}}
                for s in osm["services"] if bbox[0] <= s["lon"] <= bbox[2] and bbox[1] <= s["lat"] <= bbox[3]]
    cmap = {c["nome"] + c["istat"]: c for c in com_out}
    com_feats = []
    for c in comuni:
        st = cmap.get(c["name"] + c["istat"])
        if st:
            com_feats.append({"type": "Feature", "properties": {"nome": c["name"], "istat": c["istat"], "sal": st["sal"], "serv": st["serv"], "comb": st["comb"]},
                              "geometry": mapping(simp(c["geom"], 0.0002))})
    layers = {"fonti": vf, "servizi": sv_feats, "comuni": com_feats,
              "confine": [{"type": "Feature", "properties": {}, "geometry": mapping(simp(region, 0.0005))}],
              "arpa": [{"type": "Feature", "properties": {k: v for k, v in s.items() if k not in ("lat", "lon")},
                        "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]}} for s in stations]}
    tiles.write_vector_pmtiles(os.path.join(args.out, "vettori.pmtiles"), layers, args.work, log)

    cat_ids = list(cats.keys()); src_names = []
    def src_idx(s):
        if s not in src_names: src_names.append(s)
        return src_names.index(s)
    items = []
    for f in all_src:
        g = f["geom"]
        if not box(*ext).intersects(g) or cats[f["cat"]].get("line"):
            continue
        p = g.representative_point() if g.geom_type not in ("Point",) else g
        items.append([cat_ids.index(f["cat"]), round(p.y, 5), round(p.x, 5), round(max(r_eq(g), f.get("r0", 50) if g.geom_type.endswith("Point") else 0)),
                      f.get("wMul", 1.0), f.get("name", ""), src_idx(f.get("src", ""))])
    json.dump({"cats": cat_ids, "srcs": src_names, "items": items}, open(os.path.join(args.out, "fonti_index.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"types": serv_ids, "items": [[serv_ids.index(s["type"]), round(s["lat"], 5), round(s["lon"], 5), s["name"]] for s in osm["services"]]},
              open(os.path.join(args.out, "servizi_index.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump(com_out, open(os.path.join(args.out, "comuni.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"points": wind["points"], "period": wind["period"], "source": wind["source"]}, open(os.path.join(args.out, "vento.json"), "w"), separators=(",", ":"))
    cats_out = {k: {**v, "color": CAT_COLORS.get(k, "#666"), "count": counts.get(k, 0)} for k, v in cats.items()}
    json.dump({"bounds": bbox, "dataZoom": [cfg["data_min_zoom"], G.z], "channels": channels, "distCap": raster.DIST_CAP,
               "categories": cats_out, "groups": groups, "services": servs, "scoring": sc, "built": manifest["built"]},
              open(os.path.join(args.out, "config.json"), "w"), ensure_ascii=False, indent=1)
    manifest["sizeMB"] = round(size, 1)
    json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    log("Fatto.")


if __name__ == "__main__":
    main()
