/**
 * BookScout DE – Worker
 * --------------------------------------------------------------------
 * Wird in zwei Kontexten genutzt:
 *   1) Railway Cron Job (täglich 03:00 Uhr) – ruft `runWorker()` über CLI
 *   2) Manueller Trigger aus dem Frontend     – ruft `runWorker()` direkt
 *
 * Ablauf:
 *   1) Keepa Sync          – ASINs finden & Details laden, Upsert in DB
 *   2) Rolling Sync        – 25% ältester Produkte auswählen
 *   3) eBay Scan           – günstigstes USED-Angebot pro Produkt holen
 *   4) Abschluss-Log       – Stats
 *   5) Garbage Collection  – alte / unbrauchbare Produkte löschen
 */

import { keepaFetchProducts, keepaFindAsins } from "./keepa";
import {
  applyRateLimitBackoff,
  EbayRateLimitError,
  ebayThrottle,
  searchCheapestBook,
} from "./ebay";
import {
  garbageCollect,
  selectOldestQuartile,
  updateEbayForProduct,
  upsertProductsFromKeepa,
} from "./sync";

const MAX_CONSECUTIVE_RATE_LIMITS = 5;

function parseEnvNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

type LogFn = (line: string) => void;

export type WorkerResult = {
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  keepaUpserts: number;
  scanned: number;
  hits: number;
  deals: number;
  aborted: boolean;
  gc: { stale: number; missingPrice: number };
  errors: string[];
};

async function runKeepaSync(log: LogFn): Promise<number> {
  const minUsedPriceEur = parseEnvNumber("MIN_AMZ_USED_PRICE", 25);
  const limit = Math.floor(parseEnvNumber("MAX_SYNC_LIMIT", 500));

  log(`[Keepa] Finder: min USED ${minUsedPriceEur} EUR, Limit ${limit}, sort BSR asc`);

  const asins = await keepaFindAsins({ minUsedPriceEur, limit });
  log(`[Keepa] Gefundene ASINs: ${asins.length}`);
  if (asins.length === 0) return 0;

  const products = await keepaFetchProducts(asins);
  log(`[Keepa] Produkte mit gültigem USED-Preis: ${products.length}`);

  const upserted = await upsertProductsFromKeepa(products);
  log(`[Keepa] Upserts in Supabase: ${upserted}`);
  return upserted;
}

type EbayScanStats = {
  scanned: number;
  hits: number;
  deals: number;
  aborted: boolean;
};

async function runEbayScan(log: LogFn): Promise<EbayScanStats> {
  const candidates = await selectOldestQuartile();
  log(`[eBay] Scan-Kandidaten (25% älteste): ${candidates.length}`);

  let scanned = 0;
  let hits = 0;
  let deals = 0;
  let consecutiveRateLimits = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  for (const p of candidates) {
    await applyRateLimitBackoff(consecutiveRateLimits);
    await ebayThrottle();

    try {
      const hit = await searchCheapestBook({
        gtin: p.isbn13 ?? undefined,
        asin: p.asin ?? undefined,
        title: p.title ?? undefined,
      });

      scanned++;
      consecutiveRateLimits = 0;
      consecutiveErrors = 0;

      if (hit) {
        hits++;
        await updateEbayForProduct(p.id, hit);

        if (p.amazon_price !== null) {
          const profit = p.amazon_price - (hit.price + hit.shipping);
          if (profit > 3) deals++;
        }
      } else {
        await updateEbayForProduct(p.id, null);
      }
    } catch (err) {
      if (err instanceof EbayRateLimitError) {
        consecutiveRateLimits++;
        log(`[eBay] 429 Rate-Limit (#${consecutiveRateLimits}) bei ASIN=${p.asin}`);
        if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
          log(
            `[eBay] ${MAX_CONSECUTIVE_RATE_LIMITS}x hintereinander 429 – Worker wird beendet.`
          );
          return { scanned, hits, deals, aborted: true };
        }
        continue;
      }

      consecutiveErrors++;
      log(
        `[eBay] Fehler bei ASIN=${p.asin} (#${consecutiveErrors}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          `[eBay] ${MAX_CONSECUTIVE_ERRORS}x hintereinander Fehler (kein 429) – eBay-Scan wird abgebrochen.`
        );
        return { scanned, hits, deals, aborted: true };
      }
    }
  }

  return { scanned, hits, deals, aborted: false };
}

/**
 * Führt einen kompletten Worker-Lauf aus.
 * Kann sowohl aus der CLI als auch aus einer API-Route aufgerufen werden.
 */
export async function runWorker(logger?: LogFn): Promise<WorkerResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const log: LogFn = (line) => {
    // Immer nach console.log, zusätzlich optional in einen Buffer (z.B. fürs UI).
    console.log(line);
    if (logger) logger(line);
  };

  log(`[Worker] Start ${new Date(startedAt).toISOString()}`);

  let keepaUpserts = 0;
  try {
    keepaUpserts = await runKeepaSync(log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Keepa-Sync: ${msg}`);
    log(`[Worker] Keepa-Sync fehlgeschlagen: ${msg}`);
  }

  let stats: EbayScanStats = { scanned: 0, hits: 0, deals: 0, aborted: false };
  try {
    stats = await runEbayScan(log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`eBay-Scan: ${msg}`);
    log(`[Worker] eBay-Scan fehlgeschlagen: ${msg}`);
  }

  let gc = { stale: 0, missingPrice: 0 };
  try {
    gc = await garbageCollect();
    log(
      `[GC] gelöscht: ${gc.stale} stale (>10 Tage), ${gc.missingPrice} ohne amazon_price`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`GC: ${msg}`);
    log(`[Worker] Garbage Collection fehlgeschlagen: ${msg}`);
  }

  const endedAt = Date.now();
  const durationMinutes = Number(((endedAt - startedAt) / 1000 / 60).toFixed(2));

  log(
    `[Worker] Fertig. keepaUpserts=${keepaUpserts} scanned=${stats.scanned} ` +
      `hits=${stats.hits} deals(>3€)=${stats.deals} aborted=${stats.aborted} ` +
      `laufzeit=${durationMinutes} min`
  );

  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMinutes,
    keepaUpserts,
    scanned: stats.scanned,
    hits: stats.hits,
    deals: stats.deals,
    aborted: stats.aborted,
    gc,
    errors,
  };
}

// CLI-Entry (nur wenn direkt via `ts-node src/worker/index.ts` / `node dist/worker/index.js`)
const isDirect = (() => {
  try {
    return require.main === module;
  } catch {
    return false;
  }
})();

if (isDirect) {
  runWorker()
    .then((result) => {
      if (result.aborted) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[Worker] Fataler Fehler:", err);
      process.exit(1);
    });
}
