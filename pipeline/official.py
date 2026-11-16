"""Dati ufficiali: servizi ArcGIS REST della Regione Lombardia e open data ARPA (Socrata)."""
import re, time, datetime
import requests
from shapely.geometry import shape, Point, Polygon, MultiPolygon, LineString, MultiLineString

UA = {"User-Agent": "mappa-zone-buone/1.0 (pipeline open data)"}

def _get(url, params=None, tries=3, timeout=120):
    last = None
    for k in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 429:
                time.sleep(5 * (k + 1)); continue
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last = e; time.sleep(2 * (k + 1))
    raise RuntimeError(f"{url}: {last}")

def _esri_to_geom(g):
    if g is None: return None
    if "x" in g: return Point(g["x"], g["y"])
    if "rings" in g:
        polys = [Polygon(r) for r in g["rings"] if len(r) >= 4]
        return MultiPolygon(polys) if len(polys) > 1 else (polys[0] if polys else None)
    if "paths" in g:
        ls = [LineString(p) for p in g["paths"] if len(p) >= 2]
        return MultiLineString(ls) if len(ls) > 1 else (ls[0] if ls else None)
    return None

def arcgis_query_all(layer_url, log=print, page=1000):
    feats, offset = [], 0
    while True:
        params = {"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
                  "resultOffset": offset, "resultRecordCount": page, "returnGeometry": "true"}
        try:
            j = _get(f"{layer_url}/query", params)
            batch = [(shape(f["geometry"]) if f.get("geometry") else None, f.get("properties") or {}) for f in j.get("features", [])]
        except Exception:
            params["f"] = "json"
            j = _get(f"{layer_url}/query", params)
            batch = [(_esri_to_geom(f.get("geometry")), f.get("attributes") or {}) for f in j.get("features", [])]
        feats += [(g, p) for g, p in batch if g is not None and not g.is_empty]
        if len(batch) < page or not j.get("exceededTransferLimit", len(batch) == page):
            break
        offset += page
    return feats

def _props_name(p):
    for k in p:
        if re.search(r"denomin|nome|name|descr", k, re.I) and p[k]:
            return str(p[k])
    return ""

def fetch_contaminated(cfg, log=print):
    root = cfg["arcgis_root"]; svc = cfg["contaminated_service"]
    base = f"{root}/{svc}/MapServer"
    info = _get(base, {"f": "json"})
    out, used = [], []
    for lyr in info.get("layers", []):
        nm = lyr.get("name", "")
        if lyr.get("subLayerIds"):  # gruppo
            continue
        low = nm.lower()
        if "bonificat" in low and "contaminat" not in low:
            continue
        wmul = 0.5 if "potenzial" in low else 1.0
        try:
            feats = arcgis_query_all(f"{base}/{lyr['id']}", log)
        except Exception as e:
            log(f"    layer '{nm}' non scaricato: {e}"); continue
        for g, p in feats:
            out.append({"geom": g, "cat": "contaminato", "name": _props_name(p) or nm, "wMul": wmul,
                        "src": "Regione Lombardia – AGISCO", "r0": 80})
        used.append({"layer": nm, "count": len(feats), "peso": wmul})
        log(f"    {nm}: {len(feats)} siti")
    return out, used

def discover_services(cfg, log=print):
    """Cerca nella cartella ArcGIS i servizi che corrispondono alle parole chiave configurate."""
    root = cfg["arcgis_root"]
    j = _get(root, {"f": "json"})
    services = [s for s in j.get("services", []) if s.get("type") == "MapServer"]
    found = []
    for rule in cfg.get("discover", []):
        rx = re.compile(rule["pattern"], re.I)
        for s in services:
            nm = s["name"].split("/")[-1]
            if nm == cfg["contaminated_service"] or not rx.search(nm):
                continue
            found.append({"service": nm, **rule})
    return found

def fetch_discovered(cfg, found, log=print):
    root = cfg["arcgis_root"]; feats, overlays, used = [], [], []
    wms_root = root.replace("/rest/services", "/services")
    for f in found:
        base = f"{root}/{f['service']}/MapServer"
        try:
            info = _get(base, {"f": "json"})
        except Exception as e:
            log(f"    {f['service']}: {e}"); continue
        lyrs = [l for l in info.get("layers", []) if not l.get("subLayerIds")]
        title = info.get("documentInfo", {}).get("Title") or info.get("mapName") or f["service"]
        if f.get("overlay"):
            overlays.append({"title": title, "service": f["service"],
                             "wms": f"{wms_root}/{f['service']}/MapServer/WMSServer",
                             "layers": ",".join(str(l["id"]) for l in lyrs)})
            continue
        n = 0
        for l in lyrs:
            try:
                for g, p in arcgis_query_all(f"{base}/{l['id']}", log):
                    feats.append({"geom": g, "cat": f["category"], "name": _props_name(p) or l.get("name", ""),
                                  "src": f"Regione Lombardia – {title}", "r0": 60}); n += 1
            except Exception as e:
                log(f"    {f['service']}/{l.get('name')}: {e}")
        used.append({"servizio": title, "categoria": f["category"], "count": n})
        log(f"    {title}: {n} elementi → {f['category']}")
    return feats, overlays, used

def fetch_arpa(cfg, days=365, log=print):
    """Centraline ARPA: media dell'ultimo anno di PM10, PM2.5, NO2 per stazione."""
    soc = cfg["socrata"]
    stations = _get(f"{soc}/{cfg['arpa_stations_dataset']}.json", {"$limit": 50000})
    def kind(s):
        t = (s.get("nometiposensore") or "").lower()
        if "2.5" in t or "2,5" in t: return "pm25"
        if "pm10" in t: return "pm10"
        if "azoto" in t and "biossido" in t: return "no2"
        return None
    sensors = {}
    for s in stations:
        k = kind(s)
        if not k or s.get("datastop"):
            continue
        lat = s.get("lat"); lon = s.get("lng") or s.get("long") or s.get("lon")
        if lat is None or lon is None:
            loc = s.get("location") or {}
            lat = loc.get("latitude"); lon = loc.get("longitude")
        if lat is None or lon is None:
            continue
        sensors[str(s["idsensore"])] = {"kind": k, "lat": float(lat), "lon": float(lon),
                                        "station": s.get("nomestazione", ""), "idst": str(s.get("idstazione", ""))}
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat() + "T00:00:00"
    q = {"$select": "idsensore, avg(valore) as media, count(valore) as n",
         "$where": f"data >= '{since}' AND valore >= 0 AND stato = 'VA'",
         "$group": "idsensore", "$limit": 50000}
    rows = _get(f"{soc}/{cfg['arpa_measures_dataset']}.json", q, timeout=300)
    st = {}
    for r in rows:
        s = sensors.get(str(r.get("idsensore")))
        if not s or int(float(r.get("n", 0))) < 60:  # almeno 60 misure (PM spesso giornaliero, NO2 orario)
            continue
        e = st.setdefault(s["idst"], {"name": s["station"], "lat": s["lat"], "lon": s["lon"]})
        e[s["kind"]] = round(float(r["media"]), 1)
    out = [v for v in st.values() if any(k in v for k in ("pm25", "pm10", "no2"))]
    log(f"    ARPA: {len(out)} stazioni con medie annuali")
    return out
