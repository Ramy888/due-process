import { useState } from "react";
import { Ban, BookCheck, ChevronDown, Clock, CircleDollarSign, Gavel, Megaphone, PenLine, Shield, Siren, type LucideIcon } from "lucide-react";
import { short, txUrl, usd, type Approval, type Courtroom, type DeskState, type TrailEntry } from "../desk";
import { Decide } from "./Approvals";
import { Avatar } from "./Avatar";
import { Badge, Ext, Mono } from "./ui";

const entry = (entries: TrailEntry[], kind: string) => entries.find((e) => e.kind === kind);

function Station({ icon: Icon, name, value, state }: { icon: LucideIcon; name: string; value: string; state: "done" | "waiting" | "todo" }) {
  const ring = state === "done" ? "bg-court text-white" : state === "waiting" ? "bg-amber-400 text-court animate-pulse" : "bg-stone-100 text-stone-400";
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center text-center">
      <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full sm:h-12 sm:w-12 ${ring}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">{name}</span>
      <span className="text-xs text-stone-700">{value}</span>
    </li>
  );
}

/** Your decision, as a bubble from the "You" station. On a phone the stations sit three to a row, so "You" is centred;
 * wider, it is the fifth of six, at 75% of the court's width: the bubble floats right (the alerts fill the space beside
 * it) and its arrow is placed back under the station. */
function DecisionBubble({ approval }: { approval: Extract<Approval, { kind: "sanctions" }> }) {
  return (
    <div className="relative mt-3 sm:float-right sm:ml-4 sm:mr-[max(0px,calc(25%-14rem))] sm:w-[28rem]">
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 shadow-lg">
        <p className="text-sm text-amber-950">
          <strong>Your decision.</strong> The judge's sanctions are written on-chain only if you approve them.
        </p>
        <ul className="mt-2 space-y-0.5 text-sm text-amber-950">
          {approval.request.sanctions.map((s) => (
            <li key={s.defendant}>
              <strong>{s.defendant}</strong>:{" "}
              {[s.slashUsd > 0 && `bond −${usd(s.slashUsd, 2)}`, s.suspendLicence && "licence suspended", s.revokeAutoApprove && "auto-approve revoked 24 h"]
                .filter(Boolean)
                .join(", ")}
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Decide approval={approval} yes="Approve sanctions" />
        </div>
      </div>
      <span aria-hidden className="absolute -top-1.5 left-1/2 z-10 h-3 w-3 sm:left-[max(50%,calc(28rem-25cqw))] -translate-x-1/2 rotate-45 border-l-2 border-t-2 border-amber-300 bg-amber-50" />
    </div>
  );
}

function Count({ charge, ruling, defense, agent }: { charge: any; ruling?: any; defense?: any; agent: string }) {
  const [open, setOpen] = useState(false);
  const plea = defense?.responses?.find((r: any) => r.count === charge.count);
  return (
    <li className="relative rounded-xl border border-stone-200 bg-white p-3">
      {ruling && (
        <span
          className={`absolute right-3 top-3 rotate-[-6deg] rounded border-2 px-1.5 py-0.5 text-[11px] font-black tracking-widest ${ruling.guilty ? "border-rose-600 text-rose-700" : "border-emerald-600 text-emerald-700"}`}
        >
          {ruling.guilty ? "GUILTY" : "NOT GUILTY"}
        </span>
      )}
      <div className="flex items-center gap-2 pr-24">
        <Avatar agent={agent} size={26} />
        <span className="text-sm font-semibold">{charge.defendant}</span>
      </div>
      <p className="mt-1 pr-2 text-sm text-stone-800">{charge.count.replace(/^Count \d+:\s*/, "")}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {charge.citations.map((c: string) => (
          <Badge key={c} tone="violet">
            {c}
          </Badge>
        ))}
        {charge.exhibits.map((x: string) => (
          <Badge key={x}>{x}</Badge>
        ))}
      </div>
      <button onClick={() => setOpen(!open)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-court">
        Read the case <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-stone-50 p-3 text-sm text-stone-700">
          <p>
            <strong>Prosecutor:</strong> {charge.allegation}
          </p>
          {plea && (
            <p>
              <strong>Defense ({plea.plea}):</strong> {plea.argument}
            </p>
          )}
          {ruling && (
            <p>
              <strong>Judge:</strong> {ruling.reasoning}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function Court({ court, runId, state }: { court: Courtroom; runId: string | null; state: DeskState }) {
  if (court.alerts.length === 0 && court.entries.length === 0) return null;
  const opened = entry(court.entries, "case.opened");
  const referral = entry(court.entries, "case.referral");
  const charges: any[] = entry(court.entries, "case.charges")?.data.charges ?? [];
  const defenses = court.entries.filter((e) => e.kind === "case.defense").map((e) => e.data);
  const ruling = entry(court.entries, "case.ruling")?.data;
  const approval = court.entries.find((e) => e.kind.startsWith("sanctions."));
  const pending = state.approvals.find((a): a is Extract<Approval, { kind: "sanctions" }> => a.kind === "sanctions");
  const waiting = !!pending;
  const agentOf = (name: string) => (name === "Desk Chief" ? "CHIEF" : state.traders.find((t) => t.name === name)?.key ?? "");
  const exhibits: { id: string; title: string; refs: Record<string, string | null> }[] = opened?.data.exhibits ?? [];
  const guilty = ruling?.rulings.filter((r: any) => r.guilty).length ?? 0;

  return (
    <section className="@container mb-8 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-serif text-xl font-semibold text-court">The court</h2>
        <span className="text-xs text-stone-500">Simulated proceeding. Real rules apply to these AI agents by analogy only.</span>
      </div>

      <ol className="mt-5 grid grid-cols-3 gap-y-4 sm:flex sm:items-start sm:gap-1">
        <Station icon={Siren} name="Surveillance" value={`${court.alerts.length} alerts`} state="done" />
        <Station icon={Megaphone} name="Prosecutor" value={charges.length ? `${charges.length} counts` : "…"} state={charges.length ? "done" : "todo"} />
        <Station icon={Shield} name="Defense" value={defenses.length ? `${defenses.length} answers` : "…"} state={defenses.length ? "done" : "todo"} />
        <Station icon={Gavel} name="Judge" value={ruling ? `${guilty} guilty` : "…"} state={ruling ? "done" : "todo"} />
        <Station icon={PenLine} name="You" value={approval ? (approval.kind === "sanctions.approved" ? "approved" : "declined") : waiting ? "your turn" : "…"} state={approval ? "done" : waiting ? "waiting" : "todo"} />
        <Station icon={BookCheck} name="Ledger" value={court.judgments.length ? `${court.judgments.filter((j) => j.recorded).length} judgments` : "…"} state={court.judgments.length ? "done" : "todo"} />
      </ol>
      {pending && <DecisionBubble approval={pending} />}

      <ul className="mt-5 flex flex-wrap gap-2">
        {court.alerts.map((a) => (
          <li key={a.code} className="flex max-w-full items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
            <Siren className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong className="font-semibold">{a.code.replace("_", " ").toLowerCase()}</strong>: {a.detail}
            </span>
          </li>
        ))}
      </ul>
      {referral && (
        <details className="mt-3 text-sm text-stone-600">
          <summary className="cursor-pointer text-court">Surveillance's referral to the prosecutor</summary>
          <p className="mt-2">{referral.data.memo}</p>
        </details>
      )}

      {charges.length > 0 && (
        <ul className="mt-5 grid clear-both gap-3 md:grid-cols-2">
          {charges.map((c) => (
            <Count
              key={c.count}
              charge={c}
              agent={agentOf(c.defendant)}
              ruling={ruling?.rulings.find((r: any) => r.defendant === c.defendant && r.count === c.count)}
              defense={defenses.find((d: any) => d.defendant === c.defendant)}
            />
          ))}
        </ul>
      )}

      {ruling && (
        <blockquote className="mt-5 flex gap-3 rounded-xl bg-court p-4 text-sm leading-relaxed text-white">
          <Gavel className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <span>{ruling.summary}</span>
        </blockquote>
      )}

      {ruling?.sanctions?.length > 0 && (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {ruling.sanctions.map((s: any, i: number) => {
            const j = court.judgments[i];
            return (
              <li key={s.defendant} className="rounded-xl border border-stone-200 p-3">
                <div className="flex items-center gap-2">
                  <Avatar agent={agentOf(s.defendant)} size={26} />
                  <span className="text-sm font-semibold">{s.defendant}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-sm">
                  {s.slashUsd > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-rose-800">
                      <CircleDollarSign className="h-3.5 w-3.5" /> bond −{usd(s.slashUsd, 2)}
                    </span>
                  )}
                  {s.suspendLicence && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-rose-800">
                      <Ban className="h-3.5 w-3.5" /> licence suspended
                    </span>
                  )}
                  {s.revokeAutoApprove && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-rose-800">
                      <Clock className="h-3.5 w-3.5" /> auto-approve revoked 24 h
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs">
                  {j ? (
                    j.recorded ? (
                      j.txHash ? (
                        <Ext href={txUrl(j.txHash)}>judgment on-chain {short(j.txHash)}</Ext>
                      ) : (
                        <span className="text-stone-500">judgment encoded (local simulation)</span>
                      )
                    ) : (
                      <span className="text-rose-700">not recorded: {j.reason}</span>
                    )
                  ) : (
                    <span className="text-stone-500">{approval ? "declined, nothing written" : "awaiting your approval"}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {court.decided && (
        <p className="mt-4 text-xs text-stone-500">
          Case hash <Mono>{short(court.decided.caseHash, 10)}</Mono>{" "}
          {runId && <Ext href={`/trails/${encodeURIComponent(`${runId}:case`)}`}>verify the case trail</Ext>}
        </p>
      )}

      {exhibits.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-court">Exhibits ({exhibits.length})</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {exhibits.map((e) => (
              <li key={e.id}>
                <Badge>{e.id}</Badge> {e.title}{" "}
                {Object.entries(e.refs)
                  .filter(([k, v]) => v && (k === "txHash" || k === "settlementTx"))
                  .map(([k, v]) => (
                    <Ext key={k} href={txUrl(v!)}>
                      {k === "settlementTx" ? "x402 settlement" : "trade tx"} {short(v!)}
                    </Ext>
                  ))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
