/**
 * Keepa API Client
 * --------------------------------------------------------------------
 * Nutzt den Product Finder (selection-basiert) um Bücher
 * auf Amazon.de (domain=3) zu finden, deren USED-Preis über einem
 * Minimum liegt. Anschließend werden für die gefundenen ASINs über
 * /product die Detaildaten (inkl. Bilder, ISBN, BSR, Sales) geladen.
 * Als Amazon-Preis wird der niedrigste gültige Preis zwischen USED und
 * NEW verwendet.
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
const MAX_BSR_TARGET = 50000;
const NEW_INDEX = 1;
const USED_INDEX = 2;
const SALES_INDEX = 3;
const MAX_PRODUCT_BATCH_SIZE = 100;
const DEFAULT_PRODUCT_BATCH_SIZE = 20;
const DEFAULT_REFILL_RATE_PER_MINUTE = 20;
const PRODUCT_TOKEN_SAFETY_BUFFER = 2;

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
  refillIn?: number;
  refillRate?: number;
  error?: { type?: string; message?: string };
};

type KeepaRateLimitResponse = {
  refillIn?: number;
  refillRate?: number;
  tokensLeft?: number;
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

type KeepaSelection = Record<string, unknown>;

function requireKey(): string {
  const k = process.env.KEEPA_API_KEY;
  if (!k) throw new Error("KEEPA_API_KEY fehlt.");
  return k;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productBatchSize(): number {
  return Math.min(DEFAULT_PRODUCT_BATCH_SIZE, MAX_PRODUCT_BATCH_SIZE);
}

function parseKeepaRateLimit(body: string): KeepaRateLimitResponse | null {
  try {
    const parsed = JSON.parse(body) as KeepaRateLimitResponse;
    if (
      typeof parsed.refillIn === "number" ||
      typeof parsed.refillRate === "number" ||
      typeof parsed.tokensLeft === "number"
    ) {
      return parsed;
    }
  } catch {
    // Body was not Keepa's JSON token status payload.
  }
  return null;
}

function refillRatePerMinute(status: KeepaRateLimitResponse | null): number {
  return typeof status?.refillRate === "number" && status.refillRate > 0
    ? status.refillRate
    : DEFAULT_REFILL_RATE_PER_MINUTE;
}

function tokenSafetyBuffer(requestedTokens: number): number {
  return Math.max(PRODUCT_TOKEN_SAFETY_BUFFER, Math.ceil(requestedTokens * 0.1));
}

function tokenShortfall(status: KeepaRateLimitResponse | null, requestedTokens: number): number {
  if (requestedTokens <= 0 || typeof status?.tokensLeft !== "number") return 0;

  const safety = tokenSafetyBuffer(requestedTokens);
  if (status.tokensLeft < 0) return Math.abs(status.tokensLeft) + safety;

  return Math.max(0, requestedTokens + safety - status.tokensLeft);
}

function tokenDelayMs(status: KeepaRateLimitResponse | null, requestedTokens: number): number {
  const shortfall = tokenShortfall(status, requestedTokens);
  if (shortfall <= 0) return 0;

  return Math.ceil((shortfall / refillRatePerMinute(status)) * 60_000);
}

function keepaRateLimitDelayMs(
  status: KeepaRateLimitResponse | null,
  attempt: number,
  requestedTokens: number
): number {
  const refillDelay =
    typeof status?.refillIn === "number" && status.refillIn > 0 ? status.refillIn : 0;
  const fallbackDelay = Math.min(5_000 * attempt, 60_000);

  return Math.max(refillDelay, tokenDelayMs(status, requestedTokens), fallbackDelay) + 1_000;
}

function keepaProductPacingDelayMs(
  status: KeepaRateLimitResponse | null,
  nextBatchSize: number
): number {
  if (nextBatchSize <= 0 || typeof status?.tokensLeft !== "number") return 0;

  const delayMs = tokenDelayMs(status, nextBatchSize);
  return delayMs > 0 ? delayMs + 1_000 : 0;
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

function isValidIsbn10(isbn: string): boolean {
  const d = isbn.replace(/-/g, "");
  if (!/^\d{9}[\dXx]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(d[i], 10) * (10 - i);
  }
  const last = d[9].toUpperCase();
  sum += last === "X" ? 10 : parseInt(last, 10);
  return sum % 11 === 0;
}

function toIsbn13(isbn10: string): string {
  const d = isbn10.replace(/-/g, "").slice(0, 9);
  const base = "978" + d;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(base[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

function isLikelyBookProduct(p: KeepaRawProduct): boolean {
  const group = (p.productGroup ?? "").toLowerCase();
  if (!group) return true;
  return group.includes("book") || group.includes("buch");
}

function pickLastRank(arr: number[] | undefined): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // salesRanks-Format: [timestamp, rank, timestamp, rank, ...]
  for (let i = arr.length - 1; i >= 1; i -= 2) {
    const rank = arr[i];
    if (typeof rank === "number" && rank > 0) return rank;
  }
  return null;
}

function pickBookBsr(p: KeepaRawProduct): number | null {
  // Fuer den 50.000er-Cursor ist der Buecher-DE-Root-Rang massgeblich.
  const bookRootRank = pickLastRank(p.salesRanks?.[String(CATEGORY_BOOKS_DE)]);
  if (bookRootRank !== null) return bookRootRank;

  const fromStats = p.stats?.current?.[SALES_INDEX];
  if (typeof fromStats === "number" && fromStats > 0) return fromStats;

  // Fallback fuer Produkte ohne Root-Rank: niedrigsten Subkategorie-Rang nehmen.
  if (p.salesRanks && typeof p.salesRanks === "object") {
    let lowest: number | null = null;
    for (const arr of Object.values(p.salesRanks)) {
      const rank = pickLastRank(arr);
      if (rank !== null && (lowest === null || rank < lowest)) lowest = rank;
    }
    if (lowest !== null) return lowest;
  }

  return null;
}

/**
 * Schritt 1a – Product Finder:
 * Liefert ASINs von Büchern mit current_USED_gte >= MIN_AMZ_USED_PRICE * 100.
 * Sortiert nach BSR aufsteigend.
 */
export async function keepaFindAsins(opts: {
  minUsedPriceEur: number;
  limit: number;
  bsrFrom: number;
  bsrTo?: number;
}): Promise<string[]> {
  const key = requireKey();
  const minCents = Math.round(opts.minUsedPriceEur * 100);
  const bsrFrom = Math.max(1, Math.floor(opts.bsrFrom));
  const bsrTo = Math.max(bsrFrom, Math.floor(opts.bsrTo ?? MAX_BSR_TARGET));
  // Product Finder verlangt perPage >= 50.
  // Für Testläufe mit kleinem `limit` fragen wir deshalb eine sinnvolle
  // Mindestmenge an und schneiden das Ergebnis danach auf `limit` zurück.
  const perPage = Math.min(Math.max(opts.limit, 50), 10000);

  const baseSelection = {
    current_USED_gte: minCents,
    sort: ["current_SALES", "asc"],
    // Nur Produkte im noch offenen BSR-Fenster laden.
    current_SALES_gte: bsrFrom,
    current_SALES_lte: bsrTo,
    perPage,
    page: 0,
  };

  const selections: KeepaSelection[] = [
    // Primär: über Root-Kategorie Bücher DE.
    { ...baseSelection, rootCategory: [CATEGORY_BOOKS_DE] },
    // Fallback 1: direkte Kategorie-Inklusion.
    { ...baseSelection, categories_include: [CATEGORY_BOOKS_DE] },
    // Fallback 2: Legacy-Query (lief in manchen Accounts stabiler).
    { ...baseSelection, category: CATEGORY_BOOKS_DE },
  ];

  let lastError: Error | null = null;

  for (const selection of selections) {
    const url =
      `${KEEPA_BASE}/query` +
      `?key=${encodeURIComponent(key)}` +
      `&domain=${DOMAIN_DE}` +
      `&selection=${encodeURIComponent(JSON.stringify(selection))}`;

    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = new Error(`Keepa /query Fehler ${res.status}: ${body.slice(0, 300)}`);
      continue;
    }

    const json = (await res.json()) as KeepaFinderResponse;
    if (json.error) {
      lastError = new Error(
        `Keepa /query Fehler: ${json.error.type ?? ""} ${json.error.message ?? ""}`
      );
      continue;
    }

    const asins = (json.asinList ?? []).slice(0, opts.limit);
    if (asins.length > 0) return asins;
  }

  if (lastError) throw lastError;
  return [];
}

/**
 * Schritt 1b – Produktdetails in Batches (max. 100 ASINs pro Call).
 */
export async function keepaFetchProducts(
  asins: string[],
  opts: { minAmazonPriceEur?: number } = {}
): Promise<KeepaProduct[]> {
  const key = requireKey();
  const out: KeepaProduct[] = [];
  const minAmazonPriceEur =
    typeof opts.minAmazonPriceEur === "number" && Number.isFinite(opts.minAmazonPriceEur)
      ? opts.minAmazonPriceEur
      : null;

  const BATCH = productBatchSize();
  const MAX_PRODUCT_ATTEMPTS = 6;
  if (asins.length > 0) {
    console.log(`[Keepa] /product Batch-Groesse: ${BATCH} ASINs pro Call`);
  }

  for (let i = 0; i < asins.length; i += BATCH) {
    const chunk = asins.slice(i, i + BATCH);
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${encodeURIComponent(key)}` +
      `&domain=${DOMAIN_DE}` +
      `&asin=${encodeURIComponent(chunk.join(","))}` +
      `&stats=1&buybox=0&history=0`;

    let json: KeepaProductResponse | null = null;
    for (let attempt = 1; attempt <= MAX_PRODUCT_ATTEMPTS; attempt++) {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");

        if (res.status === 429) {
          if (attempt === MAX_PRODUCT_ATTEMPTS) {
            console.error(
              `[Keepa] /product Fehler 429 für Chunk ${i}-${i + chunk.length} nach ${attempt} Versuchen: ${body.slice(0, 200)}`
            );
            break;
          }

          const status = parseKeepaRateLimit(body);
          const delayMs = keepaRateLimitDelayMs(status, attempt, chunk.length);
          console.warn(
            `[Keepa] /product 429 für Chunk ${i}-${i + chunk.length}; warte ${Math.ceil(
              delayMs / 1000
            )}s vor Retry ${attempt + 1}/${MAX_PRODUCT_ATTEMPTS}: ${body.slice(0, 200)}`
          );
          await sleep(delayMs);
          continue;
        }

        console.error(
          `[Keepa] /product Fehler ${res.status} für Chunk ${i}-${i + chunk.length}: ${body.slice(0, 200)}`
        );
        break;
      }

      json = (await res.json()) as KeepaProductResponse;
      break;
    }

    if (!json) continue;
    if (json.error) {
      console.error(`[Keepa] /product Fehler: ${json.error.type} ${json.error.message}`);
      continue;
    }

    for (const p of json.products ?? []) {
      if (!isLikelyBookProduct(p)) continue;

      let isbn13 = pickIsbn13(p);

      // Fallback: ISBN-10 (oft identisch zur ASIN) in ISBN-13 umrechnen,
      // damit eBay exakt per gtin= suchen kann.
      if (!isbn13 && /^(\d{9}[\dXx])$/.test(p.asin) && isValidIsbn10(p.asin)) {
        isbn13 = toIsbn13(p.asin);
      }

      const usedCents = p.stats?.current?.[USED_INDEX];
      const newCents = p.stats?.current?.[NEW_INDEX];
      const usedPrice = centsToEuro(usedCents);
      const newPrice = centsToEuro(newCents);

      // Niedrigsten gültigen Preis nehmen (USED oder NEW).
      let amazon_price: number | null = null;
      if (usedPrice !== null && newPrice !== null) {
        amazon_price = Math.min(usedPrice, newPrice);
      } else if (usedPrice !== null) {
        amazon_price = usedPrice;
      } else if (newPrice !== null) {
        amazon_price = newPrice;
      }

      if (amazon_price === null) continue; // ohne gültigen Preis überspringen
      if (minAmazonPriceEur !== null && amazon_price < minAmazonPriceEur) continue;

      out.push({
        asin: p.asin,
        title: p.title ?? null,
        isbn13,
        amazon_price,
        bsr: pickBookBsr(p),
        monthly_sales:
          typeof p.monthlySold === "number" && p.monthlySold > 0 ? p.monthlySold : null,
        image_amazon: extractFirstImageUrl(p.imagesCSV ?? null),
      });
    }

    const nextBatchSize = Math.min(BATCH, Math.max(0, asins.length - (i + BATCH)));
    const pacingDelayMs = keepaProductPacingDelayMs(json, nextBatchSize);
    if (pacingDelayMs > 0) {
      const nextStart = i + BATCH;
      console.log(
        `[Keepa] /product Token-Pause ${Math.ceil(
          pacingDelayMs / 1000
        )}s vor Chunk ${nextStart}-${nextStart + nextBatchSize} ` +
          `(tokensLeft=${json.tokensLeft}, refillRate=${
            json.refillRate ?? DEFAULT_REFILL_RATE_PER_MINUTE
          }/min)`
      );
      await sleep(pacingDelayMs);
    }
  }

  return out;
}
