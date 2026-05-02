import { NextRequest, NextResponse } from "next/server";
import { getSupabase, type ProductRow } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_SIZE = 50;

function num(v: string | null, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const minProfit = num(searchParams.get("minProfit"), 5);
  const minRoi = num(searchParams.get("minRoi"), 50);
  const maxBsr = num(searchParams.get("maxBsr"), 500000);
  const minSales = num(searchParams.get("minSales"), 0);
  const buyingOption = searchParams.get("buyingOption");
  const page = Math.max(0, Math.floor(num(searchParams.get("page"), 0)));

  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  try {
    const sb = getSupabase();

    let query = sb
      .from("products")
      .select("*", { count: "exact" })
      .not("ebay_price", "is", null)
      .gt("profit_euro", 0)
      .gte("profit_euro", minProfit)
      .gte("roi_pct", minRoi)
      .lte("bsr", maxBsr)
      .order("roi_pct", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (minSales > 0) {
      query = query.gte("monthly_sales", minSales);
    }
    if (buyingOption === "auction") {
      query = query.eq("ebay_buying_option", "AUCTION");
    } else if (buyingOption === "fixed") {
      query = query.eq("ebay_buying_option", "FIXED_PRICE");
    }

    const { data, error, count } = await query;
    if (error) {
      console.error("[/api/products] Supabase-Fehler:", error.message);
      return NextResponse.json({ products: [], total: 0, error: error.message }, { status: 500 });
    }

    const products = (data ?? []) as ProductRow[];
    return NextResponse.json({
      products,
      total: count ?? products.length,
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    console.error("[/api/products] Fehler:", message);
    return NextResponse.json({ products: [], total: 0, error: message }, { status: 500 });
  }
}
