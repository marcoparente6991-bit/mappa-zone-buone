"""Estrazione da OpenStreetMap (file .osm.pbf) delle geometrie utili, classificate per categoria."""
import os, re, shutil, subprocess
import osmium
from shapely import wkb
from shapely.geometry import Point

WKB = osmium.geom.WKBFactory()

# Espressioni per `osmium tags-filter` (riduce il PBF prima dell'elaborazione in Python)
TAGS_FILTER = [
    "nwr/landuse=industrial,landfill,quarry,forest,grass,meadow,recreation_ground,village_green",
    "nwr/man_made=works,wastewater_plant", "nwr/power=plant", "nwr/telecom=data_center",
    "nwr/building=data_center,warehouse", "nwr/construction=data_center", "nwr/industrial",
    "nwr/amenity=recycling,school,kindergarten,college,university,hospital,clinic,doctors,pharmacy",
    "nwr/aeroway=aerodrome", "w/railway=rail", "nw/railway=station,halt", "n/railway=tram_stop",
    "w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,tertiary",
    "n/highway=bus_stop", "nw/station=subway", "nwr/shop=supermarket",
    "nwr/leisure=park,nature_reserve,garden", "nwr/natural=wood,water,wetland,scrub,grassland",
    "w/waterway=river,canal,riverbank", "r/boundary=administrative",
]

def prepare_pbf(urls, bbox, workdir, local_pbf=None, log=print):
    """Scarica gli estratti, li ritaglia sul riquadro e li unisce/filtra con osmium-tool (se presente)."""
    os.makedirs(workdir, exist_ok=True)
    have_cli = shutil.which("osmium") is not None
    if local_pbf:
        srcs = [local_pbf]
    else:
        import requests
        srcs = []
        for u in urls:
            dst = os.path.join(workdir, os.path.basename(u))
            if not os.path.exists(dst):
                log(f"  scarico {u}")
                with requests.get(u, stream=True, timeout=600) as r:
                    r.raise_for_status()
                    with open(dst, "wb") as f:
                        for chunk in r.iter_content(1 << 22):
                            f.write(chunk)
            srcs.append(dst)
    if not have_cli:
        log("  osmium-tool non trovato: uso il primo file senza filtri (solo per test locali)")
        return srcs[0]
    b = ",".join(str(v) for v in bbox)
    clipped = []
    for i, s in enumerate(srcs):
        out = os.path.join(workdir, f"clip_{i}.osm.pbf")
        subprocess.run(["osmium", "extract", "-b", b, "-s", "smart", s, "-o", out, "--overwrite"], check=True)
        clipped.append(out)
    merged = os.path.join(workdir, "merged.osm.pbf")
    if len(clipped) > 1:
        subprocess.run(["osmium", "merge", *clipped, "-o", merged, "--overwrite"], check=True)
    else:
        shutil.copy(clipped[0], merged)
    filtered = os.path.join(workdir, "filtered.osm.pbf")
    subprocess.run(["osmium", "tags-filter", merged, *TAGS_FILTER, "-o", filtered, "--overwrite"], check=True)
    return filtered


def _name(t):
    return t.get("name") or t.get("operator") or t.get("brand") or ""

def classify_source(t, area_m2=0):
    nl = (t.get("name", "") + " " + t.get("operator", "")).lower()
    ind = t.get("industrial", "").lower(); prod = t.get("product", "").lower()
    if t.get("aeroway") == "aerodrome":
        return "aeroporto" if t.get("iata") else "aviosuperficie"
    if t.get("railway") == "rail":
        return "ferrovia"
    if t.get("construction") == "data_center" or (t.get("telecom") == "data_center" and t.get("construction")):
        return "datacenter_progetto"
    if t.get("telecom") == "data_center" or t.get("building") == "data_center" or ind == "data_center" or re.search(r"data ?cent", nl):
        return "datacenter"
    if t.get("power") == "plant":
        s = (t.get("plant:source", "") + " " + t.get("generator:source", "")).lower()
        if "waste" in s or re.search(r"termovaloriz|inceneritor|termoutilizz|termodistruz", nl):
            return "inceneritore"
        if re.search(r"solar|wind|hydro|photovoltaic", s):
            return None
        return "centrale"
    if re.search(r"termovaloriz|inceneritor|termoutilizz", nl):
        return "inceneritore"
    if t.get("landuse") == "landfill" or "discarica" in nl:
        return "discarica"
    if t.get("landuse") == "quarry" or ind == "mine" or re.search(r"\bcava\b|\bcave\b", nl):
        return "cava"
    if ind in ("refinery", "oil") or re.search(r"raffiner|petrolchim", nl):
        return "raffineria"
    if re.search(r"asphalt|bitum", prod + ind) or re.search(r"bitum|asfalt|conglomerat", nl):
        return "bitume"
    if re.search(r"chemical|pharma", ind + prod) or re.search(r"chimic|farmac|pharma|chemical", nl):
        return "chimico"
    if re.search(r"steel|foundry|metallurg|smelter", ind) or "steel" in prod or re.search(r"acciai|ferriera|fonderi|siderurg", nl):
        return "acciaieria"
    if (t.get("man_made") == "wastewater_plant" or re.search(r"waste|scrap|recycling", ind)
            or (t.get("amenity") == "recycling" and t.get("recycling_type") == "centre") or re.search(r"depurator|rifiuti|ecologic", nl)):
        return "rifiuti"
    if re.search(r"warehouse|logistic|distribution|storage", ind) or re.search(r"amazon|logistic|\bhub\b|\bdhl\b|\bbrt\b|\bgls\b|fedex|interporto|zalando", nl):
        return None if (t.get("building") == "warehouse" and area_m2 < 3000) else "logistica"
    if t.get("building") == "warehouse":
        return "logistica" if area_m2 > 8000 else None
    if t.get("landuse") == "industrial" or t.get("man_made") == "works" or ind:
        return "industria"
    return None

def classify_road(t):
    h = t.get("highway", "")
    if h.startswith("motorway"): return "autostrada"
    if h.startswith("trunk"): return "superstrada"
    if h in ("primary", "primary_link"): return "primaria"
    if h == "secondary": return "secondaria"
    if h == "tertiary": return "terziaria"
    return None

def classify_service(t):
    a = t.get("amenity", "")
    if a in ("school", "kindergarten", "college", "university"): return "scuola"
    if a == "hospital": return "ospedale"
    if a in ("clinic", "doctors"): return "medico"
    if a == "pharmacy": return "farmacia"
    if t.get("railway") in ("station", "halt") or t.get("station") == "subway": return "stazione"
    if t.get("highway") == "bus_stop" or t.get("railway") == "tram_stop": return "fermata"
    if t.get("shop") == "supermarket": return "supermercato"
    return None

def is_green(t):
    return (t.get("leisure") in ("park", "nature_reserve", "garden")
            or t.get("landuse") in ("forest", "grass", "meadow", "recreation_ground", "village_green")
            or t.get("natural") in ("wood", "water", "wetland", "scrub", "grassland")
            or t.get("waterway") == "riverbank")

LINEAR_KEYS = ("highway", "railway", "barrier")

def _area_m2(g):
    if g.geom_type not in ("Polygon", "MultiPolygon"):
        return 0.0
    c = g.centroid
    import math
    k = 111320 * math.cos(math.radians(c.y))
    return g.area * k * 110540


def extract(pbf, log=print):
    """Restituisce dizionario con liste di feature {geom, cat|type, name, id, tags}."""
    out = {"sources": [], "roads": [], "rail": [], "greens": [], "rivers": [], "services": [], "admin": []}
    fp = osmium.FileProcessor(pbf).with_locations().with_areas()
    n = 0
    for o in fp:
        n += 1
        if n % 500000 == 0:
            log(f"  … {n:,} oggetti OSM letti")
        t = {k: v for k, v in o.tags} if len(o.tags) else {}
        if not t:
            continue
        try:
            if o.is_node():
                g = Point(o.location.lon, o.location.lat)
                st = classify_service(t)
                if st:
                    out["services"].append({"type": st, "name": _name(t), "lon": g.x, "lat": g.y})
                c = classify_source(t)
                if c and c not in ("ferrovia",):
                    out["sources"].append({"geom": g, "cat": c, "name": _name(t), "id": f"n{o.id}"})
            elif o.is_way():
                if not any(k in t for k in ("highway", "railway", "waterway")):
                    continue
                g = wkb.loads(WKB.create_linestring(o), hex=True)
                rc = classify_road(t)
                if rc:
                    out["roads"].append({"geom": g, "cat": rc, "name": ((t.get("ref", "") + " ") if t.get("ref") else "") + t.get("name", ""), "id": f"w{o.id}"})
                elif t.get("railway") == "rail" and not t.get("service"):
                    out["rail"].append({"geom": g, "cat": "ferrovia", "name": t.get("name", ""), "id": f"w{o.id}"})
                elif t.get("waterway") in ("river", "canal"):
                    out["rivers"].append({"geom": g})
                st = classify_service(t)  # stazioni mappate come way
                if st == "stazione":
                    c = g.centroid; out["services"].append({"type": st, "name": _name(t), "lon": c.x, "lat": c.y})
            elif o.is_area():
                if any(k in t for k in LINEAR_KEYS) and not t.get("aeroway") and not t.get("amenity"):
                    continue
                g = wkb.loads(WKB.create_multipolygon(o), hex=True)
                if g.is_empty:
                    continue
                oid = ("w" if o.from_way() else "r") + str(o.orig_id())
                if not o.from_way() and t.get("boundary") == "administrative" and t.get("admin_level") in ("4", "8"):
                    out["admin"].append({"geom": g, "level": int(t["admin_level"]), "name": t.get("name", ""),
                                         "istat": t.get("ref:ISTAT", ""), "id": oid})
                    continue
                st = classify_service(t)
                if st:
                    c = g.representative_point(); out["services"].append({"type": st, "name": _name(t), "lon": c.x, "lat": c.y})
                c = classify_source(t, _area_m2(g))
                if c and c != "ferrovia":
                    out["sources"].append({"geom": g, "cat": c, "name": _name(t), "id": oid})
                elif is_green(t):
                    out["greens"].append({"geom": g})
        except Exception:
            continue  # geometrie non valide/incomplete
    log(f"  OSM: {len(out['sources'])} fonti, {len(out['roads'])} strade, {len(out['rail'])} ferrovie, "
        f"{len(out['greens'])} aree verdi/acque, {len(out['services'])} servizi, {len(out['admin'])} confini")
    return out
