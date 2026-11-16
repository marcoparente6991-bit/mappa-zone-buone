"""Verifica il parsing delle risposte dei servizi online con risposte simulate."""
import sys, json, re
sys.path.insert(0, 'pipeline')
import numpy as np, requests
import weather, official

class R:
    def __init__(self, j, code=200): self._j = j; self.status_code = code
    def json(self): return self._j
    def raise_for_status(self):
        if self.status_code >= 400: raise requests.HTTPError(str(self.status_code))

calls = []
def fake_get(url, params=None, headers=None, timeout=None):
    calls.append(url)
    p = params or {}
    if 'archive-api' in url or 'air-quality' in url:
        lats = p['latitude'].split(','); n = 24 * 30
        out = []
        for la in lats:
            if 'archive' in url:
                out.append({'latitude': float(la), 'hourly': {'wind_speed_10m': [3.0] * n, 'wind_direction_10m': [250] * n, 'precipitation': [0.1] * n}})
            else:
                out.append({'latitude': float(la), 'hourly': {'pm2_5': [18] * n, 'pm10': [28] * n, 'nitrogen_dioxide': [30] * n}})
        return R(out if len(out) > 1 else out[0])
    if url.endswith('/gpt'):
        return R({'services': [{'name': 'gpt/siti_bonificati_contaminati', 'type': 'MapServer'}, {'name': 'gpt/catasto_cave', 'type': 'MapServer'}, {'name': 'gpt/mappatura_acustica', 'type': 'MapServer'}]})
    if url.endswith('/MapServer'):
        if 'siti_bonificati' in url:
            return R({'layers': [{'id': 0, 'name': 'Siti contaminati'}, {'id': 1, 'name': 'Siti bonificati'}, {'id': 2, 'name': 'Siti potenzialmente contaminati'}]})
        return R({'mapName': 'Catasto cave', 'layers': [{'id': 0, 'name': 'Ambiti'}]})
    if url.endswith('/query'):
        if p.get('f') == 'geojson' and 'catasto_cave' in url:
            return R({'error': 'unsupported'}, 400)
        if p.get('f') == 'json':
            return R({'features': [{'attributes': {'NOME': 'Cava X'}, 'geometry': {'rings': [[[9.1, 45.5], [9.11, 45.5], [9.11, 45.51], [9.1, 45.5]]]}}]})
        return R({'features': [{'type': 'Feature', 'properties': {'DENOMINAZIONE': 'Sito A'}, 'geometry': {'type': 'Point', 'coordinates': [9.2, 45.4]}}]})
    if 'ib47-atvt' in url:
        return R([{'idsensore': '1', 'nometiposensore': 'Particelle sospese PM2.5', 'idstazione': '10', 'nomestazione': 'Milano Senato', 'lat': '45.47', 'lng': '9.19'},
                  {'idsensore': '2', 'nometiposensore': 'PM10 (SM2005)', 'idstazione': '10', 'nomestazione': 'Milano Senato', 'lat': '45.47', 'lng': '9.19'},
                  {'idsensore': '3', 'nometiposensore': 'Biossido di Azoto', 'idstazione': '11', 'nomestazione': 'Bergamo', 'lat': '45.69', 'lng': '9.67', 'datastop': '2020-01-01'}])
    if 'nicp-bhqi' in url:
        assert 'avg(valore)' in p['$select'] and 'GROUP' not in p['$select']
        return R([{'idsensore': '1', 'media': '21.4', 'n': '8000'}, {'idsensore': '2', 'media': '30.1', 'n': '8000'}, {'idsensore': '3', 'media': '40', 'n': '8000'}])
    raise AssertionError(url)

requests.get = fake_get
weather.CALLS_PER_HOUR = 10 ** 9
w = weather.fetch_wind([9.0, 45.3, 9.5, 45.6], 0.25, 30, log=lambda *a: None)
assert len(w['points']) == 3 * 2, len(w['points'])
p0 = w['points'][0]; assert abs(sum(p0['p']) - 16) < 0.01 and p0['prev_from'] == 247.5, p0
print('vento ok: prevalente da', p0['prev_from'], 'calme', p0['calm'], 'pioggia', p0['rain'])
aq = weather.fetch_aq([9.0, 45.3, 9.5, 45.6], 0.25, 30, log=lambda *a: None)
assert aq['pm25'].shape == (2, 3) and np.allclose(aq['pm25'], 18); print('aria ok', aq['pm25'].shape)
cfg = {'arcgis_root': 'https://x/expo/rest/services/gpt', 'contaminated_service': 'siti_bonificati_contaminati', 'socrata': 'https://y/resource',
       'arpa_stations_dataset': 'ib47-atvt', 'arpa_measures_dataset': 'nicp-bhqi',
       'discover': [{'pattern': 'cav[ae]', 'category': 'cava'}, {'pattern': 'acustic|rumore', 'overlay': True}]}
feats, used = official.fetch_contaminated(cfg, log=lambda *a: None)
assert [u['layer'] for u in used] == ['Siti contaminati', 'Siti potenzialmente contaminati'] and used[1]['peso'] == 0.5, used
print('AGISCO ok', used)
found = official.discover_services(cfg); print('scoperti', found)
f2, ov, u2 = official.fetch_discovered(cfg, found, log=lambda *a: None)
assert f2 and f2[0]['cat'] == 'cava' and f2[0]['name'] == 'Cava X' and ov[0]['wms'].endswith('/expo/services/gpt/mappatura_acustica/MapServer/WMSServer'), (f2, ov)
print('servizi scoperti ok', u2, ov)
st = official.fetch_arpa(cfg, log=lambda *a: None)
assert st == [{'name': 'Milano Senato', 'lat': 45.47, 'lon': 9.19, 'pm25': 21.4, 'pm10': 30.1}], st
print('ARPA ok', st)
