# Mappa zone buone – Lombardia

Piattaforma web per valutare la **salubrità** e la **dotazione di servizi** di ogni zona della Lombardia, pensata per le valutazioni immobiliari.

- Fonti di pressione retinate su mappa: industrie, logistica, data center (attivi e in progetto), rifiuti, discariche, cave, bitumi, chimico-farmaceutico, acciaierie, inceneritori, centrali, raffinerie, siti contaminati (anagrafe regionale AGISCO, SIN), PFAS, aeroporti, ferrovie, strade per categoria.
- Impatto esteso oltre il perimetro con raggi specifici per categoria, **deformati dal vento locale** (rosa dei venti degli ultimi 12 mesi) e modulati da calme di vento e piogge.
- Qualità dell'aria di fondo (CAMS) corretta con le **centraline ARPA**; mitigazione di verde, boschi, laghi e fiumi.
- Servizi: scuole, ospedali, medici, farmacie, stazioni, fermate, supermercati.
- **Pesi modificabili dal vivo**: la mappa si ricolora all'istante su tutta la regione.
- Scheda di ogni punto, **confronto immobili** con stampa/PDF ed esportazione CSV, misure, **analisi di un'area disegnata**, **filtri** (es. indice ≥ 70 e stazione entro 1 km), **classifica dei comuni**, livelli WMS ufficiali.

## Come funziona

```
pipeline/ (Python, gira su GitHub Actions ogni mese)
  OpenStreetMap (Geofabrik) ─┐
  Regione Lombardia (AGISCO, servizi ArcGIS) ─┤
  ARPA Lombardia (centraline, open data) ─┤──► griglia ~50 m su tutta la regione ──► web/public/data/
  Open-Meteo: vento/piogge ERA5, aria CAMS ─┘        (21 canali per pixel)              dati.pmtiles  (raster multi-canale)
                                                                                        vettori.pmtiles (fonti, servizi, comuni, ARPA)
web/ (Vite + MapLibre GL)                                                               indici JSON, config, manifest
  un Web Worker legge le tile multi-canale e ricalcola l'indice con i pesi scelti dall'utente
```

Tutto è statico: niente server, niente database, niente chiavi API. Il sito è pubblicato gratis su GitHub Pages.

## Messa online (una volta sola)

1. Crea su GitHub un repository **pubblico** (es. `mappa-zone-buone`) e caricaci questi file.
2. Nel repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → «Build e pubblica» → Run workflow**. Il primo calcolo richiede circa 1–2 ore (il download dei dati meteo è distanziato per rispettare i limiti gratuiti di Open-Meteo).
4. Il sito sarà su `https://<tuo-utente>.github.io/mappa-zone-buone/`.

Da lì in poi i dati si ricalcolano da soli il 3 di ogni mese. Le modifiche alla sola web app si pubblicano in pochi minuti (i dati del mese vengono riutilizzati).

## Personalizzare

- **Raggi e pesi delle categorie**: `pipeline/config.yaml`, poi Run workflow con «Ricalcola i dati».
- **Siti che mancano** (roghi, cantieri di data center, contaminazioni note, nuovi poli logistici): aggiungi file GeoJSON in `pipeline/extra/` (vedi il README in quella cartella).
- **Pesi dei gruppi, dei servizi, mitigazione, peso dell'aria**: direttamente nella web app, dal vivo.

## Sviluppo in locale

```bash
# dati di prova (senza rete)
pip install -r pipeline/requirements.txt
python tests/make_synthetic_pbf.py .cache_test/synth.osm.pbf
python pipeline/build.py --pbf .cache_test/synth.osm.pbf --offline --bbox 9.05,45.38,9.35,45.58
# web app
cd web && npm install && npm run dev
```

Per il calcolo completo servono anche `osmium-tool` e `tippecanoe` (≥ 2.17, con supporto PMTiles).

## Fonti e licenze

© OpenStreetMap contributors (ODbL) · OpenFreeMap · Esri World Imagery · Open-Meteo (CC BY 4.0) con dati ERA5 e Copernicus Atmosphere Monitoring Service · Regione Lombardia e ARPA Lombardia (open data) · Photon/Komoot (ricerca indirizzi).

## Limiti

L'indice è uno strumento di screening, non una valutazione sanitaria né una perizia ambientale. OpenStreetMap può essere incompleto; la risoluzione è ~50 m; la qualità dell'aria è un modello a scala ~10 km corretto con le centraline. Prima di un acquisto verifica PGT, zonizzazione acustica comunale, anagrafe dei siti contaminati e dati ARPA.
