"use client";

import type { ProductRow as ProductRowType } from "../../../lib/supabase";

function fmtEur(v: number | null): string {
  if (v === null || v === undefined) return "–";
  return v.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function fmtInt(v: number | null): string {
  if (v === null || v === undefined) return "–";
  return v.toLocaleString("de-DE");
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "–";
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: 0 })}%`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "–";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "–";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "gerade eben";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `vor ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 48) return `vor ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  return `vor ${diffD} Tagen`;
}

function rowBg(p: ProductRowType): string {
  const profit = p.profit_euro ?? 0;
  const roi = p.roi_pct ?? 0;
  if (profit > 10 && roi > 100) return "bg-green-100";
  if (profit >= 5 && profit <= 10) return "bg-yellow-100";
  return "";
}

function profitClass(p: ProductRowType): string {
  const profit = p.profit_euro ?? 0;
  if (profit > 10) return "font-semibold text-green-700";
  if (profit >= 5) return "font-semibold text-yellow-700";
  if (profit > 0) return "text-slate-700";
  return "text-slate-400";
}

function roiClass(p: ProductRowType): string {
  const roi = p.roi_pct ?? 0;
  if (roi > 100) return "font-semibold text-green-700";
  if (roi >= 50) return "font-semibold text-yellow-700";
  return "text-slate-700";
}

export default function ProductRow({ product: p }: { product: ProductRowType }) {
  const amazonUrl = `https://www.amazon.de/dp/${p.asin}`;
  const keepaChart = `https://graph.keepa.com/pricehistory.png?asin=${p.asin}&domain=3&salesrank=1&used=1&range=365`;

  return (
    <tr className={`${rowBg(p)} align-top`}>
      {/* Bilder – nur vorhandene anzeigen, keine leeren Platzhalter */}
      <td className="whitespace-nowrap px-3 py-3">
        <div className="flex flex-col gap-2">
          {p.image_amazon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.image_amazon}
              alt="Amazon"
              className="h-36 w-24 rounded border border-slate-200 bg-white object-contain"
              loading="lazy"
            />
          ) : (
            <div className="h-36 w-24 rounded border border-dashed border-slate-300 bg-slate-50" />
          )}
          {p.image_ebay ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.image_ebay}
              alt="eBay"
              className="h-24 w-16 rounded border border-slate-200 bg-white object-contain"
              loading="lazy"
            />
          ) : null}
        </div>
      </td>

      {/* Titel + Meta + Links + Keepa-Chart */}
      <td className="max-w-md px-3 py-3">
        <div className="font-medium text-slate-900">
          {p.title ?? <span className="text-slate-400">Kein Titel</span>}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          ASIN: <span className="font-mono">{p.asin}</span>
          {p.isbn13 && (
            <>
              {" · "}ISBN: <span className="font-mono">{p.isbn13}</span>
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <a
            href={amazonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Amazon öffnen
          </a>
          {p.ebay_url ? (
            <a
              href={p.ebay_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              eBay öffnen
            </a>
          ) : null}
        </div>
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={keepaChart}
            alt="Keepa Chart"
            className="h-auto w-full max-w-[360px] rounded border border-slate-200 bg-white"
            loading="lazy"
          />
        </div>
      </td>

      <td className="whitespace-nowrap px-3 py-3 text-right">
        <a
          href={amazonUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-900 underline-offset-2 hover:underline"
        >
          {fmtEur(p.amazon_price)}
        </a>
      </td>

      <td className="whitespace-nowrap px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {p.ebay_condition && (
            <span
              className={
                p.ebay_condition === "NEW"
                  ? "rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700"
                  : "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
              }
              title={`eBay-Zustand: ${p.ebay_condition === "NEW" ? "Neu" : "Gebraucht"}`}
            >
              {p.ebay_condition === "NEW" ? "Neu" : "Gebr."}
            </span>
          )}
          {p.ebay_url ? (
            <a
              href={p.ebay_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-900 underline-offset-2 hover:underline"
            >
              {fmtEur((p.ebay_price ?? 0) + (p.ebay_shipping ?? 0))}
            </a>
          ) : (
            fmtEur(p.ebay_price)
          )}
        </div>
        {p.ebay_shipping && p.ebay_shipping > 0 ? (
          <div className="text-xs text-slate-500">
            inkl. {fmtEur(p.ebay_shipping)} Versand
          </div>
        ) : null}
      </td>

      <td className={`whitespace-nowrap px-3 py-3 text-right ${profitClass(p)}`}>
        {fmtEur(p.profit_euro)}
      </td>

      <td className={`whitespace-nowrap px-3 py-3 text-right ${roiClass(p)}`}>
        {fmtPct(p.roi_pct)}
      </td>

      <td className="whitespace-nowrap px-3 py-3 text-right">{fmtInt(p.bsr)}</td>

      <td
        className="whitespace-nowrap px-3 py-3 text-right"
        title={p.monthly_sales ? undefined : "Keine Verkaufsdaten von Keepa verfügbar"}
      >
        {fmtInt(p.monthly_sales)}
      </td>

      <td className="whitespace-nowrap px-3 py-3 text-right text-xs text-slate-500">
        {relativeTime(p.last_checked)}
      </td>
    </tr>
  );
}
