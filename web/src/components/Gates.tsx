// The five gates every proposed trade passes, with every outcome mapped: the x402 fee, the Chainlink check, the Desk
// Chief, the human co-signature and the DeskLedger record.
import { BookCheck, CircleSlash, CircleDollarSign, Loader, PenLine, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { txUrl, type Trade } from "../desk";

export type GateState = "idle" | "running" | "ok" | "warn" | "bad" | "auto" | "pending" | "skip";
export type Gate = { key: string; name: string; icon: LucideIcon; state: GateState; label: string; href?: string; sim?: boolean };

const isLocal = (mode?: string) => mode === "local-simulation";

export function gatesFor(t: Trade): Gate[] {
  const c = t.clearance;
  const chief = t.chief?.outcome;
  const checkDone = !!c?.verdict || !!c?.failed;
  // the check ran, then the fee did not settle: the trader was not charged and never got the result
  const unsettled = !!c?.failed && !!c?.verdict;
  const stoppedAtCheck = c?.verdict === "BLOCKED" || !!c?.failed;

  const fee: Gate = { key: "fee", name: "x402 fee", icon: CircleDollarSign, ...(!c ? { state: "idle", label: "—" } : unsettled ? { state: "bad", label: "not settled" } : c.failed ? { state: "skip", label: "not charged" } : c.verdict ? { state: "ok", label: "$0.01 paid" } : { state: "ok", label: "$0.01 authorized" }) };

  const check: Gate = {
    key: "check",
    name: "Chainlink check",
    icon: ShieldCheck,
    href: c?.txHash ? txUrl(c.txHash) : undefined,
    ...(!c
      ? { state: "idle", label: "—" }
      : c.failed && !c.verdict
        ? { state: "bad", label: "could not run" }
        : c.verdict === "CLEARED"
          ? { state: "ok", label: "cleared" }
          : c.verdict === "FLAGGED"
            ? { state: "warn", label: "flagged" }
            : c.verdict === "BLOCKED"
              ? { state: "bad", label: "blocked" }
              : { state: "running", label: "checking" }),
  };

  const chiefGate: Gate = {
    key: "chief",
    name: "Desk Chief",
    icon: UserCheck,
    ...(stoppedAtCheck
      ? { state: "skip", label: "not reached" }
      : chief === "auto-approved"
        ? { state: "auto", label: "auto, no review" }
        : chief === "approved"
          ? { state: "ok", label: "approved" }
          : chief === "refused"
            ? { state: "bad", label: "refused" }
            : checkDone
              ? { state: "running", label: "reviewing" }
              : { state: "idle", label: "—" }),
  };

  const passedChief = chief === "approved" || chief === "auto-approved";
  const you: Gate = {
    key: "you",
    name: "You",
    icon: PenLine,
    ...(t.cosign?.state === "pending"
      ? { state: "pending", label: "your turn" }
      : t.cosign?.state === "approved"
        ? { state: "ok", label: "co-signed" }
        : t.cosign?.state === "declined"
          ? { state: "bad", label: "declined" }
          : passedChief
            ? { state: "skip", label: "not needed" }
            : stoppedAtCheck || chief === "refused"
              ? { state: "skip", label: "—" }
              : { state: "idle", label: "—" }),
  };

  const l = t.ledger;
  const ledger: Gate = {
    key: "ledger",
    name: "DeskLedger",
    icon: BookCheck,
    ...(c?.verdict === "BLOCKED"
      ? { state: "bad", label: "block recorded", href: c.txHash ? txUrl(c.txHash) : undefined, sim: !c.txHash }
      : c?.failed || t.cosign?.state === "declined"
        ? { state: "skip", label: "nothing written" }
        : l
          ? l.recorded
            ? l.kind === "refusal"
              ? { state: "bad", label: "refusal recorded", href: l.txHash ? txUrl(l.txHash) : undefined, sim: isLocal(l.mode) }
              : { state: "ok", label: "trade recorded", href: l.txHash ? txUrl(l.txHash) : undefined, sim: isLocal(l.mode) }
            : { state: "bad", label: `rejected: ${l.reason ?? "?"}`, href: l.txHash ? txUrl(l.txHash) : undefined }
          : (passedChief && t.cosign?.state !== "pending") || chief === "refused"
            ? { state: "running", label: "writing" }
            : { state: "idle", label: "—" }),
  };
  return [fee, check, chiefGate, you, ledger];
}

const RING: Record<GateState, string> = {
  idle: "bg-white text-stone-300 ring-stone-200",
  running: "bg-white text-court ring-court/40",
  ok: "bg-emerald-600 text-white ring-emerald-600",
  warn: "bg-amber-500 text-white ring-amber-500",
  bad: "bg-rose-600 text-white ring-rose-600",
  auto: "bg-sky-500 text-white ring-sky-500",
  pending: "bg-amber-400 text-court ring-amber-400 animate-pulse",
  skip: "bg-stone-100 text-stone-400 ring-stone-200",
};
const LINE: Record<GateState, string> = { idle: "bg-stone-200", running: "bg-stone-200", ok: "bg-emerald-400", warn: "bg-amber-400", bad: "bg-stone-200", auto: "bg-sky-400", pending: "bg-amber-300", skip: "bg-stone-200" };

export function GateRow({ gates, compact = false }: { gates: Gate[]; compact?: boolean }) {
  const size = compact ? "h-7 w-7" : "h-9 w-9 sm:h-10 sm:w-10";
  return (
    <ol className="flex items-start">
      {gates.map((g, i) => {
        const Icon = g.state === "running" ? Loader : g.state === "skip" && g.label !== "not needed" ? CircleSlash : g.icon;
        const pill = (
          <span className={`inline-flex items-center justify-center rounded-full ring-2 ${size} ${RING[g.state]}`} title={`${g.name}: ${g.label}`}>
            <Icon className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4 sm:h-5 sm:w-5"} ${g.state === "running" ? "animate-spin" : ""}`} strokeWidth={2.2} />
          </span>
        );
        return (
          <li key={g.key} className="relative flex min-w-0 flex-1 flex-col items-center text-center">
            {i < gates.length - 1 && (
              <span aria-hidden className={`absolute left-1/2 h-0.5 w-full ${compact ? "top-[13px]" : "top-[17px] sm:top-[19px]"} ${LINE[g.state]}`} />
            )}
            <div className="relative z-10 flex min-w-0 max-w-full flex-col items-center">
              {g.href ? (
                <a href={g.href} target="_blank" rel="noreferrer" className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-court">
                  {pill}
                </a>
              ) : (
                pill
              )}
              {!compact && <span className="mt-1 hidden bg-white px-1 text-[10px] font-medium uppercase tracking-wide text-stone-400 sm:block">{g.name}</span>}
              <span className={`mt-0.5 line-clamp-2 max-w-full break-words bg-white px-1 text-[11px] leading-tight ${g.state === "bad" ? "text-rose-700" : g.state === "auto" ? "text-sky-700" : "text-stone-600"}`}>
                {g.label}
                {g.sim && <span className="text-stone-400"> (sim)</span>}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
