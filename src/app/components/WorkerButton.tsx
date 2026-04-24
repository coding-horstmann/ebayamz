"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WorkerResult = {
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

type WorkerStatus =
  | { state: "idle"; last?: WorkerResult | null }
  | { state: "running"; startedAt: string; logLines: string[] }
  | { state: "done"; result: WorkerResult; logLines: string[] }
  | { state: "error"; error: string; startedAt: string; logLines: string[] };

export default function WorkerButton() {
  const [status, setStatus] = useState<WorkerStatus>({ state: "idle", last: null });
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/run-worker", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as WorkerStatus;
      setStatus(json);
      if (json.state !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (status.state === "running" && !pollRef.current) {
      pollRef.current = setInterval(fetchStatus, 3000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status.state, fetchStatus]);

  const start = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/run-worker", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        alert(`Fehler: ${json.error ?? "Unbekannt"}`);
      }
      await fetchStatus();
      setOpen(true);
    } finally {
      setSubmitting(false);
    }
  }, [fetchStatus]);

  const running = status.state === "running";
  const pillColor =
    status.state === "running"
      ? "bg-blue-100 text-blue-700"
      : status.state === "done"
      ? status.result.aborted
        ? "bg-red-100 text-red-700"
        : "bg-green-100 text-green-700"
      : status.state === "error"
      ? "bg-red-100 text-red-700"
      : "bg-slate-100 text-slate-600";

  const pillText =
    status.state === "running"
      ? "Worker läuft…"
      : status.state === "done"
      ? status.result.aborted
        ? "Zuletzt abgebrochen"
        : `Zuletzt ok – ${status.result.deals} Deals`
      : status.state === "error"
      ? "Fehler"
      : "Bereit";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Worker-Steuerung</h2>
          <p className="text-xs text-slate-500">
            Startet Keepa-Sync → eBay-Scan → Garbage Collection manuell.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${pillColor}`}
            title={status.state}
          >
            {pillText}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {open ? "Log ausblenden" : "Log anzeigen"}
          </button>
          <button
            type="button"
            onClick={start}
            disabled={running || submitting}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {running ? "Läuft…" : submitting ? "Starte…" : "Jetzt ausführen"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
          {status.state === "idle" && (
            <div className="text-slate-400">Noch kein Lauf in dieser Instanz.</div>
          )}
          {(status.state === "running" ||
            status.state === "done" ||
            status.state === "error") && (
            <>
              <div className="mb-2 text-slate-400">
                Gestartet: {new Date(
                  status.state === "done"
                    ? status.result.startedAt
                    : status.startedAt
                ).toLocaleString("de-DE")}
                {status.state === "done" && (
                  <>
                    {" · "}Dauer: {status.result.durationMinutes} min
                    {" · "}scanned={status.result.scanned}
                    {" · "}hits={status.result.hits}
                    {" · "}deals={status.result.deals}
                  </>
                )}
                {status.state === "error" && (
                  <span className="text-red-300"> · Fehler: {status.error}</span>
                )}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
                {("logLines" in status ? status.logLines : []).join("\n") || "…"}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
