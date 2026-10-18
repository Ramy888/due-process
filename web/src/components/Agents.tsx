import { Ban, CircleCheck, CircleX, Zap } from "lucide-react";
import { usd, type DeskState, type TraderState } from "../desk";
import { Avatar } from "./Avatar";

/** Budget used, as a ring around the agent's avatar. */
function BudgetRing({ agent, spent, total, dim, glow }: { agent: string; spent: number; total: number; dim: boolean; glow: boolean }) {
  const r = 25;
  const c = 2 * Math.PI * r;
  const used = Math.min(1, total > 0 ? spent / total : 0);
  return (
    <div className={`relative h-14 w-14 shrink-0 rounded-full transition-shadow duration-500 ${glow ? "shadow-[0_0_18px_4px_rgba(252,211,77,0.45)]" : ""}`}>
      <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="4" />
        {used > 0 && <circle cx="28" cy="28" r={r} fill="none" stroke="#fcd34d" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${used * c} ${c}`} />}
      </svg>
      <div className="absolute inset-[7px] flex items-center justify-center">
        <Avatar agent={agent} size={42} dim={dim} />
      </div>
    </div>
  );
}

/** One trader in the desk map: a short line beside its circle, and its full card while it trades or is hovered. */
export function AgentRow({ t, active, dim }: { t: TraderState; active: boolean; dim: boolean }) {
  const suspended = t.licence !== "active";
  const left = t.allocationUsd - t.spentUsd;
  const holdings = Object.entries(t.holdingsUsd);
  // both states take the same box, so the map never changes height as the active agent changes
  const line = active ? "hidden" : "flex group-hover:hidden group-focus:hidden";
  const card = active ? "flex ring-2 ring-amber-300" : "hidden group-hover:flex group-focus:flex";
  return (
    <li tabIndex={0} aria-label={`${t.name}: ${usd(left)} left, licence ${t.licence}`} className="group flex items-center gap-3 rounded-xl outline-none">
      <div className="relative h-[72px] min-w-0 flex-1">
        <div className={`${line} h-full flex-col items-end justify-center text-right`}>
          <span className={`max-w-full truncate text-sm font-medium ${dim ? "text-white/55" : "text-white/90"}`}>{t.name}</span>
          <span className="text-xs text-white/45">
            {usd(left)} left{suspended && <span className="font-semibold text-rose-300"> · suspended</span>}
          </span>
        </div>
        <div className={`${card} absolute inset-0 z-10 flex-col justify-center gap-0.5 rounded-xl bg-white px-3 text-court shadow-xl`}>
          <span aria-hidden className="absolute -right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 bg-white" />
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{t.name}</span>
            {suspended ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-rose-700">
                <Ban className="h-3 w-3" /> suspended
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-emerald-700">
                <CircleCheck className="h-3 w-3" /> licensed
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-stone-600">
            {usd(left)} left · P&amp;L{" "}
            <span className={t.pnlUsd > 0 ? "text-emerald-700" : t.pnlUsd < 0 ? "text-rose-700" : ""}>
              {t.pnlUsd > 0 ? "+" : ""}
              {usd(t.pnlUsd, 2)}
            </span>{" "}
            · bond <span className={t.bondUsd < 1 ? "font-semibold text-rose-700" : ""}>{usd(t.bondUsd, 2)}</span>
          </div>
          <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-stone-500">
            <span className="inline-flex items-center gap-0.5" title="approved by the Chief">
              <CircleCheck className="h-3 w-3 text-emerald-600" /> {t.approved}
            </span>
            <span className="inline-flex items-center gap-0.5" title="auto-approved, no review">
              <Zap className="h-3 w-3 text-sky-600" /> {t.autoApproved}
            </span>
            <span className="inline-flex items-center gap-0.5" title="refused by the Chief">
              <CircleX className="h-3 w-3 text-rose-600" /> {t.refused}
            </span>
            <span title="x402 fees and signals paid">x402 {usd(t.clearanceFeesUsd + t.signalsBoughtUsd, 2)}</span>
            {holdings.map(([sym, v]) => (
              <span key={sym} className="rounded-full bg-stone-100 px-1.5 font-medium text-stone-700">
                {sym} {usd(v)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <BudgetRing agent={t.key} spent={t.spentUsd} total={t.allocationUsd} dim={dim || suspended} glow={active} />
    </li>
  );
}

export function ChiefChip({ state }: { state: DeskState }) {
  const revoked = state.desk.autoApproveRevoked;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl bg-white/10 py-1 pl-1 pr-3 text-xs text-white/75">
      <Avatar agent="CHIEF" size={24} />
      <span className="font-medium text-white">Desk Chief</span>
      <span className={revoked ? "font-semibold text-rose-300" : "text-sky-300"}>
        auto-approve ≤ {usd(state.desk.autoApproveUsd)} {revoked ? "revoked" : "on"}
      </span>
      <span className="text-white/30">·</span>
      <span>bond {usd(state.chief.bondUsd, 2)}</span>
    </div>
  );
}
