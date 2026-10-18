import { Ban, CircleCheck, CircleX, Zap } from "lucide-react";
import { usd, type DeskState, type TraderState } from "../desk";
import { Avatar } from "./Avatar";

/** Budget used, as a ring around the agent's avatar. */
function BudgetRing({ agent, spent, total, dim }: { agent: string; spent: number; total: number; dim?: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const used = Math.min(1, total > 0 ? spent / total : 0);
  return (
    <div className="relative h-[72px] w-[72px] shrink-0">
      <svg viewBox="0 0 72 72" className="absolute inset-0 -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="#e7e5e4" strokeWidth="5" />
        <circle cx="36" cy="36" r={r} fill="none" stroke="#1f2a44" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${used * c} ${c}`} />
      </svg>
      <div className="absolute inset-[11px] flex items-center justify-center">
        <Avatar agent={agent} size={50} dim={dim} />
      </div>
    </div>
  );
}

function Tile({ t }: { t: TraderState }) {
  const suspended = t.licence !== "active";
  const holdings = Object.entries(t.holdingsUsd);
  return (
    <li className={`flex flex-col rounded-2xl border bg-white p-3 shadow-sm ${suspended ? "border-rose-200" : "border-stone-200"}`}>
      <div className="flex items-center gap-3 lg:flex-col lg:text-center">
        <BudgetRing agent={t.key} spent={t.spentUsd} total={t.allocationUsd} dim={suspended} />
        <div className="min-w-0">
          <div className="font-semibold leading-tight">{t.name}</div>
          <div className="text-xs text-stone-500">
            {usd(t.allocationUsd - t.spentUsd)} of {usd(t.allocationUsd)} left
          </div>
          {suspended ? (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-rose-700">
              <Ban className="h-3.5 w-3.5" /> licence suspended
            </span>
          ) : (
            <span className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700">
              <CircleCheck className="h-3.5 w-3.5" /> licensed
            </span>
          )}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-1 text-center text-xs">
        <div className="rounded-lg bg-stone-50 py-1.5">
          <dt className="text-stone-500">P&amp;L</dt>
          <dd className={`font-mono font-semibold ${t.pnlUsd > 0 ? "text-emerald-700" : t.pnlUsd < 0 ? "text-rose-700" : "text-stone-700"}`}>
            {t.pnlUsd > 0 ? "+" : ""}
            {usd(t.pnlUsd, 2)}
          </dd>
        </div>
        <div className="rounded-lg bg-stone-50 py-1.5">
          <dt className="text-stone-500">Bond</dt>
          <dd className={`font-mono font-semibold ${t.bondUsd < 1 ? "text-rose-700" : "text-stone-700"}`}>{usd(t.bondUsd, 2)}</dd>
        </div>
        <div className="rounded-lg bg-stone-50 py-1.5" title="x402 fees paid / signal income">
          <dt className="text-stone-500">x402</dt>
          <dd className="font-mono font-semibold text-stone-700">{usd(t.clearanceFeesUsd + t.signalsBoughtUsd, 2)}</dd>
        </div>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 lg:justify-center">
        <span className="inline-flex items-center gap-1" title="approved by the Chief">
          <CircleCheck className="h-3.5 w-3.5 text-emerald-600" /> {t.approved}
        </span>
        <span className="inline-flex items-center gap-1" title="auto-approved, no review">
          <Zap className="h-3.5 w-3.5 text-sky-600" /> {t.autoApproved}
        </span>
        <span className="inline-flex items-center gap-1" title="refused by the Chief">
          <CircleX className="h-3.5 w-3.5 text-rose-600" /> {t.refused}
        </span>
        {holdings.map(([sym, v]) => (
          <span key={sym} className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-700">
            {sym} {usd(v)}
          </span>
        ))}
      </div>
    </li>
  );
}

export function Agents({ state }: { state: DeskState }) {
  const revoked = state.desk.autoApproveRevoked;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-serif text-xl font-semibold text-court">The desk</h2>
        <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1 pl-1 pr-3 text-xs">
          <Avatar agent="CHIEF" size={24} />
          <span className="font-medium">Desk Chief</span>
          <span className={revoked ? "font-semibold text-rose-700" : "text-sky-700"}>auto-approve ≤ {usd(state.desk.autoApproveUsd)} {revoked ? "revoked" : "on"}</span>
          <span className="text-stone-400">·</span>
          <span className="text-stone-600">bond {usd(state.chief.bondUsd, 2)}</span>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        {state.traders.map((t) => (
          <Tile key={t.key} t={t} />
        ))}
      </ul>
    </section>
  );
}
