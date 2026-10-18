import { Play, Scale } from "lucide-react";
import type { DeskState } from "../desk";

export function Header({ state, onRun, error }: { state: DeskState | null; onRun: () => void; error: string | null }) {
  const d = state?.desk;
  const running = state?.run.status === "running";
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
        <strong>SIMULATED.</strong> AI agents trading paper money; influencers and news are synthetic. Not financial or legal advice.
      </div>
      {d?.paymentsMode === "offline" && (
        <div className="bg-rose-600 px-4 py-1 text-center text-xs font-semibold text-white">
          OFFLINE PAYMENTS: x402 signatures are checked locally and nothing is settled on-chain.
        </div>
      )}
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-court text-amber-300">
            <Scale className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-bold leading-tight tracking-tight text-court">Due Process</h1>
            <p className="text-sm text-stone-600">Licences, budgets, a Desk Chief and a court for AI trading agents.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d && (
            <>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${d.paymentsMode === "x402" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
                {d.paymentsMode === "x402" ? "x402 · test USDC" : "payments offline"}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${d.ledgerMode === "ledger" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
                {d.ledgerMode === "ledger" ? "Base Sepolia ledger" : "local simulation"}
              </span>
            </>
          )}
          <button
            onClick={onRun}
            disabled={!state || running}
            className="inline-flex items-center gap-2 rounded-xl bg-court px-4 py-2 text-sm font-semibold text-white shadow hover:bg-court/90 disabled:opacity-50"
          >
            <Play className="h-4 w-4" /> {running ? "Running…" : "Run the scenario"}
          </button>
        </div>
      </div>
      {(error || state?.run.status === "failed") && (
        <p className="mx-auto max-w-[1500px] px-4 pb-3 text-sm text-rose-700">{error ?? `Run failed: ${state?.run.error}`}</p>
      )}
    </header>
  );
}
