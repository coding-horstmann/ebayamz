/**
 * Rolling-Sync Logik
 * --------------------------------------------------------------------
 * - Upsert der aus Keepa geladenen Produkte in Supabase.
 * - Auswahl der 25% ältesten Produkte für den eBay-Scan.
 * - Auto-Cleanup am Ende des Workers.
 */

import {
  getSupabase,
  type ProductInsert,
  type ProductRow,
  type ProductUpdate,
} from "../../lib/supabase";
import type { KeepaProduct } from "./keepa";

const BSR_TARGET = 50000;
const PRODUCT_RETENTION_DAYS = 30;
const KEEPA_BSR_CURSOR_KEY = "keepa_bsr_cursor";

type KeepaBsrCursor = {
  next_bsr_from?: number;
};

/**
 * Speichert (Upsert) die von Keepa gelieferten Produkte anhand der ASIN.
 * Aktualisiert Stammdaten (title, Bilder, ISBN, BSR, Sales) und den Amazon-Preis.
 * Bestehende eBay-Daten bleiben erhalten.
 */
export async function upsertProductsFromKeepa(products: KeepaProduct[]): Promise<number> {
  if (products.length === 0) return 0;
  const sb = getSupabase();

  const rows: ProductInsert[] = products.map((p) => ({
    asin: p.asin,
    title: p.title,
    isbn13: p.isbn13,
    image_amazon: p.image_amazon,
    amazon_price: p.amazon_price,
    bsr: p.bsr,
    monthly_sales: p.monthly_sales,
  }));

  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await sb
      .from("products")
      .upsert(chunk as never, {
        onConflict: "asin",
        ignoreDuplicates: false,
        count: "exact",
      });
    if (error) {
      console.error("[Sync] Upsert-Fehler:", error.message);
      continue;
    }
    total += count ?? chunk.length;
  }
  return total;
}

function normalizeBsrCursor(value: unknown, maxBsr: number): number {
  if (!value || typeof value !== "object") return 1;
  const next = (value as KeepaBsrCursor).next_bsr_from;
  if (typeof next !== "number" || !Number.isFinite(next)) return 1;
  if (next < 1 || next > maxBsr) return 1;
  return Math.floor(next);
}

function workerStateError(errorMessage: string): Error {
  return new Error(
    `[Sync] worker_state fehlt oder ist nicht lesbar: ${errorMessage}. ` +
      "Bitte supabase/migrations/002_worker_state.sql einmal im Supabase SQL Editor ausfuehren."
  );
}

/**
 * Persistenter Keepa-Fortschritt. Nach BSR 50.000 springt der Cursor wieder auf 1.
 */
export async function getNextKeepaBsr(maxBsr = BSR_TARGET): Promise<number> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("worker_state")
    .select("value")
    .eq("key", KEEPA_BSR_CURSOR_KEY)
    .maybeSingle();

  if (error) {
    throw workerStateError(error.message);
  }

  return normalizeBsrCursor((data as { value?: unknown } | null)?.value, maxBsr);
}

export async function setNextKeepaBsr(nextBsrFrom: number, maxBsr = BSR_TARGET): Promise<void> {
  const sb = getSupabase();
  const next = nextBsrFrom < 1 || nextBsrFrom > maxBsr ? 1 : Math.floor(nextBsrFrom);
  const { error } = await sb
    .from("worker_state")
    .upsert(
      {
        key: KEEPA_BSR_CURSOR_KEY,
        value: { next_bsr_from: next },
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "key" }
    );

  if (error) {
    throw workerStateError(error.message);
  }
}

export async function countProductsUpToBsr(maxBsr = BSR_TARGET): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from("products")
    .select("*", { count: "exact", head: true })
    .not("bsr", "is", null)
    .lte("bsr", maxBsr);

  if (error) {
    console.error("[Sync] BSR-Count konnte nicht gelesen werden:", error.message);
    return 0;
  }

  return count ?? 0;
}

export async function selectProductsByAsins(
  asins: string[],
  limit: number
): Promise<ProductRow[]> {
  const sb = getSupabase();
  const uniqueAsins = Array.from(new Set(asins.filter(Boolean)));
  if (uniqueAsins.length === 0 || limit <= 0) return [];

  const rows: ProductRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < uniqueAsins.length && rows.length < limit; i += CHUNK) {
    const chunk = uniqueAsins.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from("products")
      .select("*")
      .in("asin", chunk)
      .order("bsr", { ascending: true, nullsFirst: false })
      .limit(limit - rows.length);

    if (error) {
      console.error("[Sync] Batch-Auswahl fuer eBay fehlgeschlagen:", error.message);
      continue;
    }

    rows.push(...(((data ?? []) as unknown as ProductRow[])));
  }

  return rows.slice(0, limit);
}

export async function selectEbayBacklog(
  limit: number,
  excludeAsins: string[] = [],
  maxBsr = BSR_TARGET
): Promise<ProductRow[]> {
  if (limit <= 0) return [];
  const sb = getSupabase();
  const excluded = Array.from(new Set(excludeAsins.filter(Boolean)));

  const { data, error } = await sb
    .from("products")
    .select("*")
    .not("bsr", "is", null)
    .lte("bsr", maxBsr)
    .order("last_checked", { ascending: true, nullsFirst: true })
    .order("bsr", { ascending: true, nullsFirst: false })
    .limit(limit + excluded.length);
  if (error) {
    console.error("[Sync] Backlog-Auswahl fuer eBay fehlgeschlagen:", error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as ProductRow[];
  if (excluded.length === 0) return rows.slice(0, limit);
  const excludedSet = new Set(excluded);
  return rows.filter((row) => !excludedSet.has(row.asin)).slice(0, limit);
}

/**
 * Aktualisiert die eBay-Daten und den last_checked-Zeitstempel eines Produkts.
 * Wenn `hit` null ist, wird ebay_price auf null gesetzt (kein Treffer).
 */
export async function updateEbayForProduct(
  id: number,
  hit: {
    price: number;
    shipping: number;
    itemWebUrl: string | null;
    imageUrl: string | null;
    condition: "NEW" | "USED";
    buyingOption: "FIXED_PRICE" | "AUCTION";
  } | null
): Promise<void> {
  const sb = getSupabase();
  const patch: ProductUpdate = hit
    ? {
        ebay_price: hit.price,
        ebay_shipping: hit.shipping,
        ebay_url: hit.itemWebUrl,
        image_ebay: hit.imageUrl,
        ebay_condition: hit.condition,
        ebay_buying_option: hit.buyingOption,
        last_checked: new Date().toISOString(),
      }
    : {
        ebay_price: null,
        ebay_shipping: null,
        ebay_url: null,
        ebay_condition: null,
        ebay_buying_option: null,
        // image_ebay absichtlich nicht zurücksetzen – kann hilfreich bleiben
        last_checked: new Date().toISOString(),
      };

  const { error } = await sb
    .from("products")
    .update(patch as never)
    .eq("id", id);
  if (error) {
    console.error(`[Sync] Update id=${id} fehlgeschlagen:`, error.message);
  }
}

/**
 * Garbage Collection:
 * - Produkte mit last_checked älter als 30 Tage -> löschen.
 * - Produkte mit amazon_price IS NULL -> löschen.
 *
 * Gibt die Anzahl gelöschter Zeilen zurück (approximativ).
 */
export async function garbageCollect(): Promise<{ stale: number; missingPrice: number }> {
  const sb = getSupabase();
  const staleBefore = new Date(
    Date.now() - PRODUCT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let stale = 0;
  let missingPrice = 0;

  {
    const { error, count } = await sb
      .from("products")
      .delete({ count: "exact" })
      .lt("last_checked", staleBefore);
    if (error) {
      console.error("[GC] Stale-Delete-Fehler:", error.message);
    } else {
      stale = count ?? 0;
    }
  }

  {
    const { error, count } = await sb
      .from("products")
      .delete({ count: "exact" })
      .is("amazon_price", null);
    if (error) {
      console.error("[GC] MissingPrice-Delete-Fehler:", error.message);
    } else {
      missingPrice = count ?? 0;
    }
  }

  return { stale, missingPrice };
}
