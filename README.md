# BookScout DE

Online-Arbitrage-Tool für gebrauchte Bücher: Erkennt Preisdifferenzen zwischen
**eBay.de** (günstig kaufen) und **Amazon.de** (teurer verkaufen).

- **Worker:** Node.js / TypeScript, läuft täglich um 03:00 Uhr auf Railway (Cron) **und** kann per Button manuell gestartet werden.
- **Datenbank:** Supabase (PostgreSQL).
- **Frontend:** Next.js 14 (App Router) + Tailwind CSS, optional mit Basic Auth.
- **APIs:** Keepa (Produktfinder + Details) und eBay Browse API v1 (OAuth2).

---

## 1. Setup in 5 Schritten (lokal)

1. `npm install`
2. In Supabase neues Projekt anlegen und `supabase/schema.sql` im SQL-Editor ausführen.
3. `.env.local` mit Werten befüllen (Keepa, eBay, Supabase, optional Passwort).
4. `npm run dev` → http://localhost:3000
5. Im UI oben rechts auf „Jetzt ausführen" klicken → erster Worker-Lauf.

---

## 2. Umgebungsvariablen

| Variable                    | Zweck                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `EBAY_CLIENT_ID`            | OAuth2 Client Credentials (Production)                               |
| `EBAY_CLIENT_SECRET`        | OAuth2 Client Credentials (Production)                               |
| `EBAY_MARKETPLACE_ID`       | `EBAY_DE`                                                            |
| `EBAY_API_DELAY_MS`         | Pause zwischen Calls, Default `1100`                                 |
| `KEEPA_API_KEY`             | Keepa API-Key                                                        |
| `SUPABASE_URL`              | Supabase Projekt-URL                                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-Role-Key (Server-only!)                                      |
| `MIN_AMZ_USED_PRICE`        | Mindest-USED-Preis EUR für neue ASINs, Default `25`                  |
| `MAX_SYNC_LIMIT`            | BSR-Fenstergroesse und eBay-Abgleiche pro Lauf, Default `4000`       |
| `BOOKSCOUT_USER`            | Basic-Auth-Username fürs Frontend, Default `admin`                   |
| `BOOKSCOUT_PASSWORD`        | Basic-Auth-Passwort. **Leer = keine Auth** (Seite öffentlich)        |

---

## 3. Worker-Ablauf

1. **Keepa Sync:** Product Finder (`domain=3`, Kategorie `186606 – Bücher DE`,
   `current_USED_gte`, sortiert nach BSR aufsteigend) startet beim Cursor aus
   `worker_state` und holt das nächste `MAX_SYNC_LIMIT`-BSR-Fenster bis
   maximal BSR `50000`. Nach BSR `50000` springt der Cursor wieder auf BSR `1`.
2. **eBay Scan:** Der gerade geladene Keepa-Block wird direkt mit eBay
   abgeglichen. Freie Slots bis `MAX_SYNC_LIMIT` werden mit altem Backlog
   aufgefüllt.
3. **eBay Suche:** Für jedes Produkt das günstigste passende `FIXED_PRICE`
   Angebot (Versand DE) suchen. Rate-Limit:
   `EBAY_API_DELAY_MS` zwischen Calls, exponentieller Backoff bei 429. Nach
   5× 429 hintereinander bricht der Worker ab.
4. **Abschluss-Log:** Scan-Anzahl, Treffer, Deals mit Profit > 3 €, Laufzeit.
5. **Garbage Collection:** Löscht Produkte mit `last_checked > 30 Tage`
   oder `amazon_price IS NULL`.

Suchstrategie pro Produkt: ISBN-13 via `gtin=`, sonst `q=` mit den ersten
60 Zeichen des Titels.

---

## 4. Worker ausführen

| Weg                     | Kommando / Aktion                                |
| ----------------------- | ------------------------------------------------ |
| Lokal (einmalig)        | `npm run worker`                                 |
| Lokal im UI             | Button „Jetzt ausführen" in der oberen Kachel    |
| Railway Cron            | Automatisch täglich `0 3 * * *`                  |
| Railway manuell         | Im Dashboard „Run Now" am Worker-Service         |
| Web-API                 | `POST /api/admin/run-worker` (mit Basic Auth)    |

---

## 5. Deployment auf Railway

`railway.toml` enthält den Standard-Start für den **Web-Service**:

- `web` – Next.js Frontend (`npm run build && npm start`).

Für den **Cron-Worker-Service** musst du in Railway explizit einen anderen
Start-Command setzen, damit nicht versehentlich nur Next.js gestartet wird.

### Railway Setup (empfohlen)

1. **Zwei Services in Railway anlegen**
   - `ebayamz` (Web)
   - `giving-embrace` (Cron Worker)

2. **Web-Service (`ebayamz`)**
   - Start Command: `npm run build && npm start`
   - Public Networking: an
   - Cron: aus

3. **Worker-Service (`giving-embrace`)**
   - Cron Schedule: `0 3 * * *`
   - Start Command: `npm run railway:worker`
   - Public Networking: aus (nicht nötig)
   - Hinweis: Der Worker-Prozess beendet sich nach dem Lauf absichtlich selbst.

4. **Node-Version**
   - `package.json` setzt `engines.node` auf `>=20.11.0`.
   - Beim Deploy sollte Railway daher Node 20+ verwenden.

5. **ENV-Variablen**
   - Beide Services brauchen:
     `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_MARKETPLACE_ID`,
     `EBAY_API_DELAY_MS`, `KEEPA_API_KEY`, `SUPABASE_URL`,
     `SUPABASE_SERVICE_ROLE_KEY`, `MIN_AMZ_USED_PRICE`, `MAX_SYNC_LIMIT`.
   - Nur Web zusätzlich:
     `BOOKSCOUT_USER`, `BOOKSCOUT_PASSWORD` (optional).

6. **Supabase Migration**
   - Einmalig `supabase/migrations/002_worker_state.sql` im Supabase SQL Editor
     ausfuehren. Das legt nur die kleine Tabelle `worker_state` an.
   - Das JSON in `worker_state.value` schreibt der Worker automatisch; dort
     muss nichts manuell eingefuegt werden.

Warum das wichtig ist:
Wenn der Cron-Service als Start-Command `npm run build && npm start` hat,
dann startet um 03:00 Uhr nur ein Webserver. Der eigentliche Job
(`runWorker()`) läuft dann nicht als geplanter Worker-Lauf.

---

## 6. Projektstruktur

```
src/
  middleware.ts         # Basic Auth fürs gesamte Frontend
  worker/
    index.ts            # CLI-Entry + exportierte runWorker()-Funktion
    keepa.ts            # Keepa API client
    ebay.ts             # eBay API client (OAuth2 + Search + Rate-Limit)
    sync.ts             # Rolling-sync Logik + GC
  app/
    page.tsx            # Dashboard
    layout.tsx
    globals.css
    api/
      products/route.ts      # Gefilterte Produkte
      admin/run-worker/route.ts  # Worker manuell starten / Status
    components/
      FilterPanel.tsx
      ProductTable.tsx
      ProductRow.tsx
      WorkerButton.tsx
lib/
  supabase.ts           # Supabase client (service role)
supabase/
  schema.sql            # DB-Schema
```

---

## 7. Tipps

- Keepa-Preise sind in Cent – Worker rechnet sie korrekt um. `-1` bedeutet
  „nicht verfügbar" und wird übersprungen.
- Fuer das Ziel "50.000 ASINs in 14 Tagen" bei taeglichem Railway-Cron:
  `MAX_SYNC_LIMIT=4000`. Der Worker macht dann pro Lauf den naechsten
  BSR-Block, gleicht diesen Block direkt mit eBay ab und faengt nach BSR
  `50000` wieder bei BSR `1` an.
- Farblogik in der Tabelle:
  - Profit > 10 € **und** ROI > 100 % → grüner Hintergrund.
  - Profit 5–10 € → gelber Hintergrund.
- Deals werden nur angezeigt, wenn `profit_euro > 0` **und** `ebay_price`
  vorhanden ist. Das Frontend filtert zusätzlich nach den vom User
  eingestellten Mindestwerten.
