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

/**
 * Gibt die 25% der Produkte zurück, deren `last_checked` am längsten her ist.
 * Mindestens 1 Produkt wenn die Tabelle nicht leer ist.
 */
export async function selectOldestQuartile(): Promise<ProductRow[]> {
  const sb = getSupabase();

  const { count, error: countErr } = await sb
    .from("products")
    .select("*", { count: "exact", head: true });
  if (countErr) {
    console.error("[Sync] Count-Fehler:", countErr.message);
    return [];
  }
  if (!count || count === 0) return [];

  const limit = Math.max(1, Math.floor(count * 0.25));

  const { data, error } = await sb
    .from("products")
    .select("*")
    .order("last_checked", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) {
    console.error("[Sync] Select-Fehler:", error.message);
    return [];
  }
  return (data ?? []) as unknown as ProductRow[];
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
        last_checked: new Date().toISOString(),
      }
    : {
        ebay_price: null,
        ebay_shipping: null,
        ebay_url: null,
        ebay_condition: null,
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
 * - Produkte mit last_checked älter als 10 Tage -> löschen.
 * - Produkte mit amazon_price IS NULL -> löschen.
 *
 * Gibt die Anzahl gelöschter Zeilen zurück (approximativ).
 */
export async function garbageCollect(): Promise<{ stale: number; missingPrice: number }> {
  const sb = getSupabase();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  let stale = 0;
  let missingPrice = 0;

  {
    const { error, count } = await sb
      .from("products")
      .delete({ count: "exact" })
      .lt("last_checked", tenDaysAgo);
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
