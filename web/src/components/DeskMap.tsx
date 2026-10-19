// The hero: the desk's traders with their budgets, who is trading right now, and how far their trade got through the
// five gates. The trades panel beside it tells the same story in detail.
import { ArrowDown, Gavel, Loader, CircleSlash } from "lucide-react";
import { usd, type Approval, type BeatCard, type DeskState, type Floor, type Trade } from "../desk";
import { AgentRow, ChiefChip } from "./Agents";
import { Decide } from "./Approvals";
import { gatesFor, type Gate, type GateState } from "./Gates";
import { Market } from "./Market";

const NODE: Record<GateState, string> = {
  idle: "bg-white/5 text-white/30 ring-white/15",
  running: "bg-white/10 text-white ring-white/60",
  ok: "bg-emerald-500 text-white ring-emerald-300/60",
  warn: "bg-amber-400 text-court ring-amber-200/60",
  bad: "bg-rose-500 text-white ring-rose-300/60",
  auto: "bg-sky-400 text-court ring-sky-200/60",
  pending: "bg-amber-300 text-court ring-amber-100 animate-pulse",
  skip: "bg-white/5 text-white/30 ring-white/10",
};

/** How far the trade got: the last gate that is not waiting. */
const frontier = (gates: Gate[]) => {
  let last = -1;
  gates.forEach((g, i) => {
    if (g.state !== "idle" && g.state !== "skip") last = i;
  });
  return last;
};

function caption(name: string, beat: BeatCard | undefined, t: Trade | undefined, gates: Gate[], coSignUsd: number): string {
  if (!t) return !beat ? "Press Run to start the Frog Day scenario." : beat.done ? `${name} did not trade.` : `${name} is reading its feed.`;
  const d = t.decision;
  if (d.action === "pass") return `${name} looked and decided not to trade.`;
  const want = `${name} wants to ${d.side} ${d.symbol} for ${usd(d.notionalUsd)}.`;
  const [fee, check, chief, you, ledger] = gates;
  if (check.state === "running") return `${want} Its $0.01 fee is authorized; Chainlink is checking the token.`;
  if (fee.label === "not settled") return `${want} Its $0.01 fee did not settle, so the result was withheld.`;
  if (check.label === "blocked") return `${want} Chainlink blocked it; the block is on the record.`;
  if (check.state === "bad") return `${want} The check could not run, so nothing was charged.`;
  if (chief.state === "running") return `${want} Cleared. The Desk Chief is reviewing it against the whole desk.`;
  if (chief.label === "refused")
    return `${want} Cleared, but the Desk Chief refused it; ${ledger.state === "running" ? "recording the refusal" : "the refusal is on the record"}.`;
  if (you.state === "pending") return `${want} The Chief approved. It is over ${usd(coSignUsd)}, so it waits for your co-signature.`;
  if (you.label === "declined") return `${want} You declined to co-sign, so nothing was written.`;
  if (chief.state === "auto") return `${want} Small and cleared, so it passed on the Chief's auto-approve rule with no review.`;
  if (ledger.state === "running") return `${want} Approved; the Desk Writer is recording it.`;
  if (ledger.label.startsWith("rejected")) return `${want} The ledger rejected it: ${ledger.label.replace("rejected: ", "")}.`;
  if (ledger.state === "ok") return `${want} Approved and recorded on the ledger.`;
  return want;
}

export function DeskMap({ state, floor, onCourt }: { state: DeskState; floor: Floor; onCourt: () => void }) {
  const beat = floor.beats.at(-1);
  const trade = beat?.trades.at(-1);
  const gates = trade && trade.decision.action === "trade" ? gatesFor(trade) : gatesFor({ decision: { action: "pass", symbol: "", side: "buy", notionalUsd: 0, reasoning: "", evidence: [] }, staged: false }).map((g) => ({ ...g, state: "idle" as GateState, label: "" }));
  const reached = frontier(gates);
  const name = state.traders.find((t) => t.key === beat?.trader)?.name ?? "";
  const courtLive = floor.court.alerts.length > 0;
  const active = courtLive ? undefined : beat?.trader;
  const cosign = state.approvals.find((a): a is Extract<Approval, { kind: "cosign" }> => a.kind === "cosign");
  const sanctions: { defendant: string }[] = floor.court.entries.find((e) => e.kind === "case.ruling")?.data.sanctions ?? [];
  const awaiting = state.approvals.some((a) => a.kind === "sanctions");
  const courtCaption = floor.court.decided
    ? floor.court.decided.approved
      ? "You approved the sanctions; the judgments are on the record."
      : "You declined the sanctions; nothing was written."
    : floor.court.entries.some((e) => e.kind === "sanctions.approved")
      ? "You approved the sanctions; the Desk Writer is recording the judgments."
      : awaiting
      ? `The judge found ${sanctions.map((x) => x.defendant).join(" and ")} guilty. The sanctions wait for your approval.`
      : `Surveillance found ${floor.court.alerts.length} problems after the trades; the court is hearing the case.`;

  return (
    <section aria-label="The desk" className="flex flex-col gap-4 rounded-3xl bg-court p-4 text-white shadow-lg sm:p-6 lg:min-h-0 lg:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ChiefChip state={state} />
        <button
          type="button"
          onClick={onCourt}
          disabled={!courtLive}
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs transition-colors ${courtLive ? "bg-rose-500/25 font-semibold text-white hover:bg-rose-500/40" : "bg-white/5 text-white/40"}`}
        >
          <Gavel className={`h-4 w-4 ${courtLive ? "text-amber-300" : ""}`} />
          Court · {courtLive ? `${floor.court.alerts.length} alerts` : "quiet"}
          {courtLive && <ArrowDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-6 md:flex-row md:items-center">
        <ul aria-label="Traders" className="flex shrink-0 flex-col gap-1.5 md:w-72 lg:w-[19rem] xl:w-[22rem]">
          {state.traders.map((t) => (
            <AgentRow key={t.key} t={t} active={t.key === active} dim={!!active && t.key !== active} />
          ))}
        </ul>

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="relative">
            {/* the track, and how far the current trade got along it */}
            <div className="absolute left-[10%] right-[10%] top-6 h-1 rounded bg-white/10 sm:top-7" />
            <div
              className="absolute left-[10%] top-6 h-1 rounded bg-amber-300 transition-all duration-700 sm:top-7"
              style={{ width: `${Math.max(0, reached) * 20}%` }}
            />
            {reached >= 0 && (
              <div
                className="absolute top-[18px] h-4 w-4 -translate-x-1/2 rounded-full bg-amber-300 shadow-[0_0_16px_4px_rgba(252,211,77,0.6)] transition-all duration-700 sm:top-[22px]"
                style={{ left: `${10 + reached * 20}%` }}
              />
            )}
            <ol className="relative grid grid-cols-5">
              {gates.map((g) => {
                const Icon = g.state === "running" ? Loader : g.state === "skip" && g.label !== "not needed" ? CircleSlash : g.icon;
                return (
                  <li key={g.key} className="flex min-w-0 flex-col items-center text-center">
                    <span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl ring-4 transition-colors duration-500 sm:h-14 sm:w-14 ${NODE[g.state]}`}>
                      <Icon className={`h-5 w-5 sm:h-6 sm:w-6 ${g.state === "running" ? "animate-spin" : ""}`} />
                    </span>
                    <span className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-white/60 sm:text-[11px]">{g.name}</span>
                    <span className="line-clamp-2 min-h-[2rem] max-w-full px-1 text-[11px] leading-tight text-white/90 sm:text-xs">{g.label}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          <p className="min-h-[2.5rem] text-center text-sm text-white/90 sm:text-base" aria-live="polite">
            {courtLive ? courtCaption : caption(name, beat, trade, gates, state.desk.coSignUsd)}
          </p>
          {cosign && !courtLive && (
            <div className="flex justify-center">
              <Decide approval={cosign} yes={`Co-sign ${usd(cosign.request.notionalUsd)} ${cosign.request.symbol}`} dark />
            </div>
          )}
          {awaiting && (
            <div className="flex justify-center">
              <button onClick={onCourt} className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-court shadow hover:bg-amber-300">
                Review the sanctions <ArrowDown className="h-4 w-4" />
              </button>
            </div>
          )}

          <Market state={state} />
        </div>
      </div>
    </section>
  );
}
