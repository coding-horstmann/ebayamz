/**
 * Keepa API Client
 * --------------------------------------------------------------------
 * Nutzt den Product Finder (selection-basiert) um gebrauchte Bücher
 * auf Amazon.de (domain=3) zu finden, deren USED-Preis über einem
 * Minimum liegt. Anschließend werden für die gefundenen ASINs über
 * /product die Detaildaten (inkl. Bilder, ISBN, BSR, Sales) geladen.
 *
 * Docs: https://keepa.com/#!discuss/t/product-finder/1332
 *       https://keepa.com/#!discuss/t/product-object/116
 *
 * Index-Konventionen der Keepa-CSV/stats-Arrays (domain=3):
 *   0  AMAZON
 *   1  NEW
 *   2  USED
 *   3  SALES (BSR)
 *   11 NEW_FBM_SHIPPING
 *   ...
 *   Preise sind immer in Cent. Wert -1 = "nicht verfügbar".
 */

const KEEPA_BASE = "https://api.keepa.com";
const DOMAIN_DE = 3;
const CATEGORY_BOOKS_DE = 186606;
const USED_INDEX = 2;
const SALES_INDEX = 3;

export type KeepaProduct = {
  asin: string;
  title: string | null;
  isbn13: string | null;
  amazon_price: number | null; // EUR
  bsr: number | null;
  monthly_sales: number | null;
  image_amazon: string | null;
};

type KeepaFinderResponse = {
  asinList?: string[];
  tokensLeft?: number;
  error?: { type?: string; message?: string };
};

type KeepaProductResponse = {
  products?: KeepaRawProduct[];
  tokensLeft?: number;
  error?: { type?: string; message?: string };
};

type KeepaRawProduct = {
  asin: string;
  title?: string | null;
  imagesCSV?: string | null;
  salesRanks?: Record<string, number[]> | null;
  monthlySold?: number | null;
  stats?: {
    current?: Array<number>;
  } | null;
  eanList?: string[] | null;
  upcList?: string[] | null;
  productGroup?: string | null;
};

function requireKey(): string {
  const k = process.env.KEEPA_API_KEY;
  if (!k) throw new Error("KEEPA_API_KEY fehlt.");
  return k;
}

function centsToEuro(cents: number | undefined | null): number | null {
  if (cents === undefined || cents === null) return null;
  if (cents < 0) return null; // -1 => nicht verfügbar
  return Math.round(cents) / 100;
}

function extractFirstImageUrl(imagesCSV: string | null | undefined): string | null {
  if (!imagesCSV) return null;
  const first = imagesCSV.split(",")[0]?.trim();
  if (!first) return null;
  return `https://images-na.ssl-images-amazon.com/images/I/${first}`;
}

function pickIsbn13(p: KeepaRawProduct): string | null {
  const candidates = [...(p.eanList ?? []), ...(p.upcList ?? [])];
  for (const c of candidates) {
    const digits = (c ?? "").replace(/\D/g, "");
    if (digits.length === 13 && (digits.startsWith("978") || digits.startsWith("979"))) {
      return digits;
    }
  }
  return null;
}

function isLikelyBookProduct(p: KeepaRawProduct): boolean {
  const group = (p.productGroup ?? "").toLowerCase();
  return group.includes("book") || group.includes("buch");
}

function pickLowestBsr(p: KeepaRawProduct): number | null {
  // Bevorzuge salesRanks (alle Kategorien, niedrigsten Wert nehmen).
  if (p.salesRanks && typeof p.salesRanks === "object") {
    let lowest: number | null = null;
    for (const arr of Object.values(p.salesRanks)) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      // salesRanks-Format: [timestamp, rank, timestamp, rank, ...]
      // Wir nehmen den letzten Rank-Eintrag (letzter bekannter Wert).
      for (let i = arr.length - 1; i >= 1; i -= 2) {
        const rank = arr[i];
        if (typeof rank === "number" && rank > 0) {
          if (lowest === null || rank < lowest) lowest = rank;
          break;
        }
      }
    }
    if (lowest !== null) return lowest;
  }
  // Fallback: stats.current[SALES_INDEX]
  const fromStats = p.stats?.current?.[SALES_INDEX];
  if (typeof fromStats === "number" && fromStats > 0) return fromStats;
  return null;
}

/**
 * Schritt 1a – Product Finder:
 * Liefert ASINs gebrauchter Bücher mit current_USED_gte >= MIN_AMZ_USED_PRICE * 100.
 * Sortiert nach BSR aufsteigend.
 */
export async function keepaFindAsins(opts: {
  minUsedPriceEur: number;
  limit: number;
}): Promise<string[]> {
  const key = requireKey();
  const minCents = Math.round(opts.minUsedPriceEur * 100);

  const selection = {
    category: CATEGORY_BOOKS_DE,
    current_USED_gte: minCents,
    sort: ["current_SALES", "asc"],
    // Nur Produkte mit einer Amazon-Verkaufsrangliste (liefert BSR-Kandidaten):
    current_SALES_gte: 1,
    perPage: Math.min(opts.limit, 10000),
    page: 0,
  };

  const url =
    `${KEEPA_BASE}/query` +
    `?key=${encodeURIComponent(key)}` +
    `&domain=${DOMAIN_DE}` +
    `&selection=${encodeURIComponent(JSON.stringify(selection))}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Keepa /query Fehler ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as KeepaFinderResponse;
  if (json.error) {
    throw new Error(`Keepa /query Fehler: ${json.error.type ?? ""} ${json.error.message ?? ""}`);
  }

  const asins = (json.asinList ?? []).slice(0, opts.limit);
  return asins;
}

/**
 * Schritt 1b – Produktdetails in Batches (max. 100 ASINs pro Call).
 */
export async function keepaFetchProducts(asins: string[]): Promise<KeepaProduct[]> {
  const key = requireKey();
  const out: KeepaProduct[] = [];

  const BATCH = 100;
  for (let i = 0; i < asins.length; i += BATCH) {
    const chunk = asins.slice(i, i + BATCH);
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${encodeURIComponent(key)}` +
      `&domain=${DOMAIN_DE}` +
      `&asin=${encodeURIComponent(chunk.join(","))}` +
      `&stats=1&buybox=0&history=0`;

    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[Keepa] /product Fehler ${res.status} für Chunk ${i}-${i + chunk.length}: ${body.slice(0, 200)}`
      );
      continue;
    }

    const json = (await res.json()) as KeepaProductResponse;
    if (json.error) {
      console.error(`[Keepa] /product Fehler: ${json.error.type} ${json.error.message}`);
      continue;
    }

    for (const p of json.products ?? []) {
      if (!isLikelyBookProduct(p)) continue;

      const isbn13 = pickIsbn13(p);
      // Für BookScout verarbeiten wir bewusst nur Produkte mit ISBN-13,
      // damit Elektronik/sonstige Kategorien sicher ausgeschlossen bleiben.
      if (!isbn13) continue;

      const usedCents = p.stats?.current?.[USED_INDEX];
      const amazon_price = centsToEuro(usedCents);
      if (amazon_price === null) continue; // ohne gültigen USED-Preis überspringen

      out.push({
        asin: p.asin,
        title: p.title ?? null,
        isbn13,
        amazon_price,
        bsr: pickLowestBsr(p),
        monthly_sales:
          typeof p.monthlySold === "number" && p.monthlySold > 0 ? p.monthlySold : null,
        image_amazon: extractFirstImageUrl(p.imagesCSV ?? null),
      });
    }
  }

  return out;
}
