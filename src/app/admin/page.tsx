import WorkerButton from "../components/WorkerButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Administration</h2>
        <p className="text-sm text-slate-500">
          Worker-Steuerung, Logs und manuelle Ausführung.
        </p>
      </div>
      <WorkerButton />
    </div>
  );
}
