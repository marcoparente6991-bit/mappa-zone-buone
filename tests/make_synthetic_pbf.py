"""Genera un piccolo .osm.pbf sintetico (zona di Milano) per testare la pipeline senza rete."""
import sys, random, os
import osmium
from osmium.osm.mutable import Node, Way, Relation
random.seed(1)
out = sys.argv[1]
if os.path.exists(out): os.remove(out)
nodes, ways, rels = [], [], []
nid = [1]; wid = [1]; rid = [1]
def node(lon, lat, tags=None):
    i = nid[0]; nid[0] += 1; nodes.append(Node(id=i, location=(lon, lat), tags=tags or {}, version=1)); return i
def way(coords, tags, closed=False):
    ids = [node(*c) for c in coords]
    if closed: ids.append(ids[0])
    i = wid[0]; wid[0] += 1; ways.append(Way(id=i, nodes=ids, tags=tags, version=1)); return i
def rect(lon, lat, dx, dy, tags):
    return way([(lon, lat), (lon + dx, lat), (lon + dx, lat + dy), (lon, lat + dy)], tags, closed=True)
def rel(outer_way_ids, tags):
    i = rid[0]; rid[0] += 1; rels.append(Relation(id=i, members=[("w", w, "outer") for w in outer_way_ids], tags=tags, version=1)); return i
# comuni (4 quadranti) come relazioni
W0, S0, W1, N1 = 9.05, 45.38, 9.35, 45.58; mx, my = 9.20, 45.48
for k, (a, b, c, d) in enumerate([(W0, my, mx, N1), (mx, my, W1, N1), (W0, S0, mx, my), (mx, S0, W1, my)]):
    w = way([(a, b), (c, b), (c, d), (a, d)], {}, closed=True)
    rel([w], {"type": "boundary", "boundary": "administrative", "admin_level": "8", "name": f"Comune {k+1}", "ref:ISTAT": f"01514{k}"})
# fonti
for i in range(25):
    rect(9.25 + random.random() * 0.08, 45.40 + random.random() * 0.15, 0.004, 0.003, {"landuse": "industrial", "name": f"Zona industriale {i}"})
rect(9.30, 45.45, 0.006, 0.004, {"building": "warehouse", "name": "Amazon MXP9"})
node(9.10, 45.50, {"telecom": "data_center", "name": "DC Test"})
rect(9.08, 45.42, 0.004, 0.004, {"power": "plant", "plant:source": "waste", "name": "Termovalorizzatore Test"})
rect(9.32, 45.55, 0.006, 0.005, {"landuse": "landfill", "name": "Discarica Test"})
rect(9.06, 45.55, 0.008, 0.006, {"landuse": "quarry", "name": "Cava Test"})
rect(9.27, 45.52, 0.003, 0.003, {"landuse": "industrial", "industrial": "chemical", "name": "Chimica Test"})
# strade e ferrovia
way([(9.05, 45.40), (9.20, 45.41), (9.35, 45.43)], {"highway": "motorway", "ref": "A1"})
way([(9.05, 45.47), (9.35, 45.47)], {"highway": "primary", "name": "Via Primaria"})
way([(9.15, 45.38), (9.16, 45.58)], {"highway": "secondary", "name": "Via Secondaria"})
for i in range(10):
    y = 45.39 + i * 0.02; way([(9.05, y), (9.35, y + 0.005)], {"highway": "tertiary"})
way([(9.05, 45.53), (9.35, 45.51)], {"railway": "rail", "name": "Linea Test"})
# verde e acque
rect(9.12, 45.44, 0.02, 0.015, {"leisure": "park", "name": "Parco Test"})
rect(9.18, 45.53, 0.03, 0.02, {"landuse": "forest"})
rect(9.22, 45.39, 0.01, 0.01, {"natural": "water", "name": "Lago Test"})
way([(9.05, 45.45), (9.20, 45.46), (9.35, 45.50)], {"waterway": "river", "name": "Fiume Test"})
# servizi
for i in range(30):
    node(9.06 + random.random() * 0.28, 45.39 + random.random() * 0.18, {"amenity": "school", "name": f"Scuola {i}"})
for i in range(120):
    node(9.06 + random.random() * 0.28, 45.39 + random.random() * 0.18, {"highway": "bus_stop"})
for i in range(15):
    node(9.06 + random.random() * 0.28, 45.39 + random.random() * 0.18, {"amenity": "pharmacy", "name": f"Farmacia {i}"})
for i in range(12):
    node(9.06 + random.random() * 0.28, 45.39 + random.random() * 0.18, {"shop": "supermarket", "name": f"Super {i}"})
node(9.19, 45.47, {"amenity": "hospital", "name": "Ospedale Test"})
node(9.14, 45.50, {"railway": "station", "name": "Stazione Test"})
node(9.24, 45.46, {"railway": "station", "name": "Stazione Est"})
node(9.20, 45.49, {"amenity": "doctors", "name": "Ambulatorio"})
with osmium.SimpleWriter(out) as w:
    for n in nodes: w.add_node(n)
    for x in ways: w.add_way(x)
    for r in rels: w.add_relation(r)
print("ok", len(nodes), len(ways), len(rels))
