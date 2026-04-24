import { NextResponse } from "next/server";
import { runWorker, type WorkerResult } from "../../../../worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * In-Memory Status für den aktuellen Worker-Lauf.
 * ACHTUNG: Nur pro Web-Instanz. Bei mehreren Instanzen zeigt jede ihren eigenen Stand.
 * Für dieses Tool absolut ausreichend, weil es ein kleines Admin-Panel ist.
 */
type WorkerStatus =
  | { state: "idle"; last?: WorkerResult | null }
  | { state: "running"; startedAt: string; logLines: string[] }
  | { state: "done"; result: WorkerResult; logLines: string[] }
  | { state: "error"; error: string; startedAt: string; logLines: string[] };

const g = globalThis as unknown as { __bookscoutStatus?: WorkerStatus };
if (!g.__bookscoutStatus) g.__bookscoutStatus = { state: "idle", last: null };

function setStatus(s: WorkerStatus) {
  g.__bookscoutStatus = s;
}
function getStatus(): WorkerStatus {
  return g.__bookscoutStatus ?? { state: "idle", last: null };
}

export async function GET() {
  return NextResponse.json(getStatus());
}

export async function POST() {
  const current = getStatus();
  if (current.state === "running") {
    return NextResponse.json(
      { ok: false, error: "Ein Worker-Lauf läuft bereits.", status: current },
      { status: 409 }
    );
  }

  const startedAt = new Date().toISOString();
  const logLines: string[] = [];
  setStatus({ state: "running", startedAt, logLines });

  // Fire-and-forget: wir geben sofort Response zurück, Worker läuft im Hintergrund.
  void runWorker((line) => {
    logLines.push(line);
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  })
    .then((result) => {
      setStatus({ state: "done", result, logLines });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Admin] Worker-Lauf fehlgeschlagen:", msg);
      setStatus({ state: "error", error: msg, startedAt, logLines });
    });

  return NextResponse.json({ ok: true, startedAt });
}
