# Dati aggiuntivi

Metti qui file `.geojson` (coordinate WGS84, lon/lat) con siti che OpenStreetMap o i dati ufficiali non contengono: roghi segnalati, cantieri o progetti di data center, contaminazioni note, nuovi poli logistici, ecc.

Ogni feature (punto, linea o poligono) deve avere queste proprietà:

| proprietà | obbligatoria | significato |
|---|---|---|
| `categoria` | sì | una chiave di `categories` in `config.yaml` (es. `datacenter_progetto`, `contaminato`, `logistica`, `discarica`) |
| `nome` | no | testo mostrato nella scheda |
| `raggio` | no | raggio in metri del sito, solo per i punti (predefinito 100) |
| `peso` | no | moltiplicatore del peso della categoria (predefinito 1; es. 0.5 per un sito bonificato) |
| `fonte` | no | da dove viene l'informazione |

Esempio (`esempio.geojson.txt` in questa cartella: rinominalo in `.geojson` per usarlo).

Dopo aver aggiunto o modificato un file, il workflow ricalcola i dati automaticamente al push.
