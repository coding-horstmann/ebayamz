/**
 * eBay Browse API Client
 * --------------------------------------------------------------------
 * - OAuth2 Client Credentials (Token wird gecacht bis 5min vor Ablauf)
 * - Browse API: item_summary/search
 * - Conservative Rate Limiting: EBAY_API_DELAY_MS zwischen Calls
 * - Exponentieller Backoff bei 429 über `applyRateLimitBackoff()`
 */

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

export type EbayConditionCategory = "NEW" | "USED";

export type EbayHit = {
  price: number;
  shipping: number;
  itemWebUrl: string | null;
  imageUrl: string | null;
  /** Kategorisierung für UI/DB: "NEW" bei Condition 1000/1500, sonst "USED". */
  condition: EbayConditionCategory;
  /** Original-Condition-Text von eBay (z.B. "Neu", "Gebraucht", "Sehr gut") */
  conditionText: string | null;
  /** Numerische eBay-Condition-ID (1000, 1500, 3000, 4000, 5000) */
  conditionId: number | null;
};

/**
 * Welche eBay-Condition-IDs BookScout akzeptiert:
 *   1000 – New
 *   1500 – New other (see details)
 *   3000 – Used
 *   4000 – Very Good
 *   5000 – Good
 * Explizit ausgeschlossen:
 *   2000 / 2500 – Refurbished
 *   6000        – Acceptable
 */
export const EBAY_ACCEPTED_CONDITION_IDS = [1000, 1500, 3000, 4000, 5000] as const;
const ACCEPTED_SET = new Set<number>(EBAY_ACCEPTED_CONDITION_IDS);
const NEW_CONDITION_IDS = new Set<number>([1000, 1500]);

type EbayTokenResponse = {
  access_token: string;
  expires_in: number; // seconds
  token_type: string;
};

type EbayItemSummary = {
  itemId?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: Array<{
    shippingCost?: { value?: string; currency?: string };
    shippingCostType?: string;
  }>;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  condition?: string;
  conditionId?: string | number;
};

type EbaySearchResponse = {
  itemSummaries?: EbayItemSummary[];
  total?: number;
};

export class EbayRateLimitError extends Error {
  constructor() {
    super("eBay rate limit (429)");
    this.name = "EbayRateLimitError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} fehlt in den Umgebungsvariablen.`);
  return v;
}

/* ----------------------------- OAuth ----------------------------- */

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getEbayAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 5 * 60 * 1000 > now) {
    return cachedToken.value;
  }

  const clientId = requireEnv("EBAY_CLIENT_ID");
  const clientSecret = requireEnv("EBAY_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: OAUTH_SCOPE,
  }).toString();

  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`eBay OAuth Fehler ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = (await res.json()) as EbayTokenResponse;
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

/* ---------------------------- Search ----------------------------- */

const BASE_DELAY_MS = Number(process.env.EBAY_API_DELAY_MS ?? "1100");
const EBAY_FETCH_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = EBAY_FETCH_RETRIES
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      // 5xx sind oft transient - kurz warten und nochmal probieren.
      if (res.status >= 500 && res.status <= 599 && attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Wartet die Basis-Delay zwischen zwei Requests ab.
 * Der Worker ruft diese Funktion VOR jedem Request auf.
 */
export async function ebayThrottle(): Promise<void> {
  await sleep(BASE_DELAY_MS);
}

/**
 * Exponentieller Backoff, wenn gerade 429s passieren.
 * delay = BASE_DELAY * (consecutiveRateLimits + 1)
 */
export async function applyRateLimitBackoff(consecutiveRateLimits: number): Promise<void> {
  if (consecutiveRateLimits <= 0) return;
  const delay = BASE_DELAY_MS * (consecutiveRateLimits + 1);
  await sleep(delay);
}

type SearchOpts = {
  gtin?: string;
  asin?: string;
  title?: string;
};

function parseConditionId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function itemToHit(item: EbayItemSummary): EbayHit | null {
  const conditionId = parseConditionId(item.conditionId);
  // Zusätzliche Absicherung: eBay sollte das per Filter gar nicht liefern,
  // aber falls doch, lieber verwerfen.
  if (conditionId !== null && !ACCEPTED_SET.has(conditionId)) return null;

  const priceStr = item.price?.value;
  if (!priceStr) return null;
  const price = Number.parseFloat(priceStr);
  if (!Number.isFinite(price)) return null;

  let shipping = 0;
  const shipCost = item.shippingOptions?.[0]?.shippingCost?.value;
  if (shipCost) {
    const parsed = Number.parseFloat(shipCost);
    if (Number.isFinite(parsed) && parsed > 0) shipping = parsed;
  }

  const imageUrl =
    item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null;

  const category: EbayConditionCategory =
    conditionId !== null && NEW_CONDITION_IDS.has(conditionId) ? "NEW" : "USED";

  return {
    price,
    shipping,
    itemWebUrl: item.itemWebUrl ?? null,
    imageUrl,
    condition: category,
    conditionText: item.condition ?? null,
    conditionId,
  };
}

/**
 * Sucht das günstigste Exemplar (Neu oder Gebraucht) auf eBay.de.
 * Akzeptierte Conditions: 1000, 1500, 3000, 4000, 5000 – siehe
 * `EBAY_ACCEPTED_CONDITION_IDS`. Refurbished (2000/2500) und Acceptable (6000)
 * sind ausgeschlossen.
 *
 * Sofortkauf (FIXED_PRICE), Versand Deutschland, sortiert nach
 * Preis + Versand aufsteigend. Gibt `null` zurück, wenn nichts Passendes da ist.
 *
 * Wirft `EbayRateLimitError` bei HTTP 429.
 */
export async function searchCheapestBook(opts: SearchOpts): Promise<EbayHit | null> {
  const token = await getEbayAccessToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID ?? "EBAY_DE";

  const conditionFilter = EBAY_ACCEPTED_CONDITION_IDS.join("|");
  const commonParams = {
    filter: `conditionIds:{${conditionFilter}},buyingOptions:{FIXED_PRICE},deliveryCountry:DE`,
    sort: "pricePlusShipping",
    limit: "10",
  };

  const attempts: Array<{ mode: "gtin" | "q"; value: string }> = [];
  const seen = new Set<string>();
  const pushAttempt = (mode: "gtin" | "q", value: string) => {
    const v = value.trim();
    if (!v) return;
    const key = `${mode}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ mode, value: v });
  };

  if (opts.gtin && /^\d{8,14}$/.test(opts.gtin)) pushAttempt("gtin", opts.gtin);
  // Viele DE-Buchangebote matchen über ISBN-10/ASIN besser als über gtin.
  if (opts.asin && /^\d{10}$/.test(opts.asin)) pushAttempt("q", opts.asin);
  if (opts.title) pushAttempt("q", opts.title.slice(0, 60));
  if (attempts.length === 0) return null;

  for (const attempt of attempts) {
    const params = new URLSearchParams();
    params.set(attempt.mode, attempt.value);
    params.set("filter", commonParams.filter);
    params.set("sort", commonParams.sort);
    params.set("limit", commonParams.limit);

    const url = `${SEARCH_URL}?${params.toString()}`;
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      throw new EbayRateLimitError();
    }

    if (res.status === 401) {
      cachedToken = null;
      const body = await res.text().catch(() => "");
      throw new Error(`eBay 401 Unauthorized – Token ungültig. Body: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`eBay Browse Fehler ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as EbaySearchResponse;
    const items = json.itemSummaries ?? [];
    if (items.length === 0) continue;

    // Items sind bereits nach Preis+Versand aufsteigend sortiert.
    for (const item of items) {
      const hit = itemToHit(item);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * @deprecated Kompatibilität zur vorigen Version – bitte `searchCheapestBook` nutzen.
 */
export const searchCheapestUsed = searchCheapestBook;
