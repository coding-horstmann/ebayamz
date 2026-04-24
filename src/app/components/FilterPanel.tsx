"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export type Filters = {
  minProfit: number;
  minRoi: number;
  maxBsr: number;
  minSales: number;
};

export default function FilterPanel({ initial }: { initial: Filters }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [minProfit, setMinProfit] = useState(initial.minProfit);
  const [minRoi, setMinRoi] = useState(initial.minRoi);
  const [maxBsr, setMaxBsr] = useState(initial.maxBsr);
  const [minSales, setMinSales] = useState(initial.minSales);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(sp?.toString() ?? "");
    params.set("minProfit", String(minProfit));
    params.set("minRoi", String(minRoi));
    params.set("maxBsr", String(maxBsr));
    params.set("minSales", String(minSales));
    startTransition(() => {
      router.push(`/?${params.toString()}`);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5"
    >
      <Field
        label="Mindest-Profit (€)"
        value={minProfit}
        onChange={setMinProfit}
        step="0.5"
        min={0}
      />
      <Field
        label="Mindest-ROI (%)"
        value={minRoi}
        onChange={setMinRoi}
        step="1"
        min={0}
      />
      <Field
        label="Max. BSR"
        value={maxBsr}
        onChange={setMaxBsr}
        step="10000"
        min={0}
      />
      <Field
        label="Min. Verkäufe/Monat"
        value={minSales}
        onChange={setMinSales}
        step="1"
        min={0}
      />
      <div className="flex items-end">
        <button
          type="submit"
          disabled={isPending}
          className="h-10 w-full rounded-md bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {isPending ? "Filtere…" : "Filtern"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: string;
  min: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
    </label>
  );
}
