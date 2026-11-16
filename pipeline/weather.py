"""Vento, piogge (ERA5) e qualità dell'aria (CAMS) da Open-Meteo, su una griglia di punti."""
import time, datetime
import numpy as np
import requests

UA = {"User-Agent": "mappa-zone-buone/1.0"}

def grid_points(bbox, step):
    lons = np.arange(bbox[0], bbox[2] + 1e-9, step); lats = np.arange(bbox[1], bbox[3] + 1e-9, step)
    return lons, lats

CALLS_PER_HOUR = 4000

def _weight(n_loc, params):
    """stima delle 'chiamate' conteggiate da Open-Meteo: località × blocchi di 14 giorni × blocchi di 10 variabili"""
    if "start_date" in params:
        days = (datetime.date.fromisoformat(params["end_date"]) - datetime.date.fromisoformat(params["start_date"])).days + 1
    else:
        days = params.get("past_days", 7) + params.get("forecast_days", 1)
    nv = len(params.get("hourly", "").split(","))
    return n_loc * max(1, -(-days // 14)) * max(1, -(-nv // 10))

def _batched(url, lons, lats, params, batch=25, log=print):
    out = []
    pts = [(lo, la) for la in lats for lo in lons]
    for i in range(0, len(pts), batch):
        chunk = pts[i:i + batch]
        p = dict(params, latitude=",".join(f"{la:.3f}" for _, la in chunk), longitude=",".join(f"{lo:.3f}" for lo, _ in chunk))
        t0 = time.time()
        for k in range(12):
            try:
                r = requests.get(url, params=p, headers=UA, timeout=300)
            except requests.RequestException:
                time.sleep(30); continue
            if r.status_code == 429:
                log("    limite Open-Meteo raggiunto: attendo"); time.sleep(60 * (k + 1)); continue
            r.raise_for_status(); break
        else:
            raise RuntimeError("Open-Meteo non risponde")
        j = r.json(); out += j if isinstance(j, list) else [j]
        pause = _weight(len(chunk), params) * 3600 / CALLS_PER_HOUR - (time.time() - t0)
        log(f"    {min(i + batch, len(pts))}/{len(pts)} punti" + (f" (pausa {pause:.0f}s per i limiti del servizio)" if pause > 5 else ""))
        if pause > 0 and i + batch < len(pts):
            time.sleep(pause)
    return out

def wind_stats(h):
    ws = np.array(h["wind_speed_10m"], dtype=float); wd = np.array(h["wind_direction_10m"], dtype=float)
    pr = np.array(h.get("precipitation") or [], dtype=float)
    ok = ~np.isnan(ws) & ~np.isnan(wd)
    ws, wd = ws[ok], wd[ok]
    calm = float(np.mean(ws < 1.5)) if len(ws) else 0.35
    m = ws >= 1.5
    sec = (np.round(wd[m] / 22.5).astype(int)) % 16
    to = np.bincount((sec + 8) % 16, weights=ws[m], minlength=16)
    fr = np.bincount(sec, weights=ws[m], minlength=16)
    sm = 0.25 * np.roll(to, 1) + 0.5 * to + 0.25 * np.roll(to, -1)
    tot = to.sum() or 1
    days = len(h["wind_speed_10m"]) / 24 or 1
    rain = float(np.nansum(pr)) * 365 / days if len(pr) else 900
    return {"p": (sm / tot * 16).round(3).tolist(), "from_pct": (fr / tot * 100).round(1).tolist(),
            "calm": round(calm, 3), "rain": round(rain), "prev_from": int(np.argmax(fr)) * 22.5}

def fetch_wind(bbox, step, days, log=print):
    end = datetime.date.today() - datetime.timedelta(days=8); start = end - datetime.timedelta(days=days)
    lons, lats = grid_points(bbox, step)
    res = _batched("https://archive-api.open-meteo.com/v1/archive", lons, lats,
                   {"start_date": start.isoformat(), "end_date": end.isoformat(),
                    "hourly": "wind_speed_10m,wind_direction_10m,precipitation", "wind_speed_unit": "ms", "timezone": "UTC"}, log=log)
    pts = []
    for (lo, la), r in zip([(lo, la) for la in lats for lo in lons], res):
        s = wind_stats(r["hourly"]); s.update(lon=round(float(lo), 3), lat=round(float(la), 3)); pts.append(s)
    return {"points": pts, "period": [start.isoformat(), end.isoformat()], "source": "Open-Meteo / ERA5"}

def fetch_aq(bbox, step, days, log=print):
    lons, lats = grid_points(bbox, step)
    end = datetime.date.today() - datetime.timedelta(days=2); start = end - datetime.timedelta(days=days)
    base = {"hourly": "pm2_5,pm10,nitrogen_dioxide", "domains": "cams_europe", "timezone": "UTC"}
    try:
        res = _batched("https://air-quality-api.open-meteo.com/v1/air-quality", lons, lats,
                       dict(base, start_date=start.isoformat(), end_date=end.isoformat()), batch=20, log=log)
        period = [start.isoformat(), end.isoformat()]
    except Exception as e:
        log(f"    storico CAMS annuale non disponibile ({e}); uso gli ultimi 92 giorni")
        res = _batched("https://air-quality-api.open-meteo.com/v1/air-quality", lons, lats,
                       dict(base, past_days=92, forecast_days=1), batch=20, log=log)
        period = ["ultimi 92 giorni", ""]
    def mean(a):
        a = np.array([v for v in a if v is not None], dtype=float); return float(a.mean()) if len(a) else np.nan
    pm25 = np.array([mean(r["hourly"]["pm2_5"]) for r in res]).reshape(len(lats), len(lons))
    pm10 = np.array([mean(r["hourly"]["pm10"]) for r in res]).reshape(len(lats), len(lons))
    no2 = np.array([mean(r["hourly"]["nitrogen_dioxide"]) for r in res]).reshape(len(lats), len(lons))
    return {"lons": lons, "lats": lats, "pm25": pm25, "pm10": pm10, "no2": no2, "period": period, "source": "CAMS Europe via Open-Meteo"}

def synthetic_wind(bbox, step):
    lons, lats = grid_points(bbox, step); pts = []
    for la in lats:
        for lo in lons:
            to = np.array([0.6] * 16); to[4] = 3; to[3] = 2; to[12] = 1.5   # prevalente da Ovest-SudOvest
            to = to / to.sum() * 16
            pts.append({"lon": round(float(lo), 3), "lat": round(float(la), 3), "p": to.round(3).tolist(),
                        "from_pct": [6.25] * 16, "calm": 0.45, "rain": 950, "prev_from": 247.5})
    return {"points": pts, "period": ["sintetico", ""], "source": "sintetico (test)"}

def synthetic_aq(bbox, step):
    lons, lats = grid_points(bbox, step)
    LO, LA = np.meshgrid(lons, lats)
    pm25 = 12 + 10 * np.exp(-((LO - 9.19) ** 2 + (LA - 45.46) ** 2) / 0.3) + 6 * (46.0 - LA).clip(0)
    return {"lons": lons, "lats": lats, "pm25": pm25, "pm10": pm25 * 1.5, "no2": pm25 * 1.6, "period": ["sintetico", ""], "source": "sintetico (test)"}
