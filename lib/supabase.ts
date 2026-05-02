import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase-Client mit Service-Role-Key.
 * WICHTIG: Dieser Client umgeht RLS – niemals im Browser verwenden.
 * Wird ausschließlich im Worker und in Server-Routen (Next.js App Router) genutzt.
 *
 * Wir verzichten hier bewusst auf das generische `Database`-Schema des
 * Supabase-Clients und cast'en stattdessen in der Aufrufstelle die Ergebnisse
 * auf `ProductRow`. Das hält die Lesestellen typsicher, ohne gegen die
 * strengen Overload-Signaturen von `.upsert()` / `.update()` zu kämpfen.
 */

export type ProductRow = {
  id: number;
  asin: string;
  isbn13: string | null;
  title: string | null;
  image_amazon: string | null;
  image_ebay: string | null;
  amazon_price: number | null;
  ebay_price: number | null;
  ebay_shipping: number | null;
  ebay_url: string | null;
  ebay_condition: "NEW" | "USED" | null;
  ebay_buying_option: "FIXED_PRICE" | "AUCTION" | null;
  bsr: number | null;
  monthly_sales: number | null;
  profit_euro: number | null;
  roi_pct: number | null;
  last_checked: string | null;
  created_at: string | null;
};

/**
 * Felder, die der Worker schreiben darf. `id`, `profit_euro`, `roi_pct`
 * werden automatisch von Postgres gesetzt und dürfen nie gesendet werden.
 */
export type ProductInsert = {
  asin: string;
  isbn13?: string | null;
  title?: string | null;
  image_amazon?: string | null;
  image_ebay?: string | null;
  amazon_price?: number | null;
  ebay_price?: number | null;
  ebay_shipping?: number | null;
  ebay_url?: string | null;
  ebay_condition?: "NEW" | "USED" | null;
  ebay_buying_option?: "FIXED_PRICE" | "AUCTION" | null;
  bsr?: number | null;
  monthly_sales?: number | null;
  last_checked?: string | null;
  created_at?: string | null;
};
export type ProductUpdate = Partial<ProductInsert>;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt in den Umgebungsvariablen."
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
