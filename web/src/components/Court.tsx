import { short, txUrl, type Courtroom, type TrailEntry } from "../desk";
import { Badge, Card, Ext, Mono } from "./ui";

const byKind = (entries: TrailEntry[], kind: string) => entries.filter((e) => e.kind === kind);

function Cites({ ids, kind }: { ids: string[]; kind: "law" | "exhibit" }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} tone={kind === "law" ? "violet" : "gray"}>
          {id}
        </Badge>
      ))}
    </span>
  );
}

export function Court({ court, runId }: { court: Courtroom; runId: string | null }) {
  if (court.alerts.length === 0 && court.entries.length === 0) return null;
  const opened = byKind(court.entries, "case.opened")[0];
  const referral = byKind(court.entries, "case.referral")[0];
  const charges = byKind(court.entries, "case.charges")[0];
  const defenses = byKind(court.entries, "case.defense");
  const ruling = byKind(court.entries, "case.ruling")[0];
  const exhibits: { id: string; title: string; refs: Record<string, string | null> }[] = opened?.data.exhibits ?? [];
  return (
    <Card title="The court" aside="Simulated proceeding. Real rules apply to these AI agents by analogy only.">
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="font-serif text-base font-semibold text-court">1. Surveillance</h3>
          <ul className="mt-1 space-y-1">
            {court.alerts.map((a) => (
              <li key={a.code}>
                <Badge tone="red">{a.code}</Badge> {a.detail}
              </li>
            ))}
          </ul>
          {referral && <p className="mt-2 text-stone-600">{referral.data.memo}</p>}
        </section>

        {charges && (
          <section>
            <h3 className="font-serif text-base font-semibold text-court">2. Charges (Prosecutor)</h3>
            <ul className="mt-1 space-y-2">
              {charges.data.charges.map((c: any) => (
                <li key={c.count}>
                  <strong>{c.defendant}</strong>: {c.count}
                  <p className="text-stone-600">{c.allegation}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Cites ids={c.citations} kind="law" /> <Cites ids={c.exhibits} kind="exhibit" />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {defenses.length > 0 && (
          <section>
            <h3 className="font-serif text-base font-semibold text-court">3. Defense</h3>
            {defenses.map((d) => (
              <div key={d.seq} className="mt-1">
                <strong>{d.data.defendant}</strong>{" "}
                {d.data.responses.map((r: any) => (
                  <Badge key={r.count} tone={r.plea === "contest" ? "blue" : r.plea === "admit" ? "amber" : "gray"}>
                    {r.plea}
                  </Badge>
                ))}
                <p className="text-stone-600">{d.data.mitigation}</p>
              </div>
            ))}
          </section>
        )}

        {ruling && (
          <section>
            <h3 className="font-serif text-base font-semibold text-court">4. Ruling (Judge)</h3>
            <ul className="mt-1 space-y-2">
              {ruling.data.rulings.map((r: any) => (
                <li key={`${r.defendant}-${r.count}`}>
                  <Badge tone={r.guilty ? "red" : "green"}>{r.guilty ? "GUILTY" : "NOT GUILTY"}</Badge> <strong>{r.defendant}</strong>: {r.count}
                  <p className="text-stone-600">{r.reasoning}</p>
                </li>
              ))}
            </ul>
            <p className="mt-2 rounded bg-stone-50 p-2">{ruling.data.summary}</p>
          </section>
        )}

        {court.decided && (
          <section>
            <h3 className="font-serif text-base font-semibold text-court">5. Your approval and the record</h3>
            <p>
              Sanctions {court.decided.approved ? <Badge tone="green">approved by you</Badge> : <Badge tone="amber">declined by you</Badge>}{" "}
              Case hash <Mono>{short(court.decided.caseHash, 10)}</Mono>{" "}
              {runId && <Ext href={`/trails/${encodeURIComponent(`${runId}:case`)}`}>verify the case trail</Ext>}
            </p>
            <ul className="mt-1 space-y-1">
              {court.judgments.map((j, i) => (
                <li key={i}>
                  <Badge tone={j.recorded ? "green" : "red"}>judgment {j.recorded ? (j.mode === "ledger" ? "recorded on DeskLedger" : "encoded (local simulation)") : "not recorded"}</Badge>{" "}
                  {j.txHash && <Ext href={txUrl(j.txHash)}>verify on-chain {short(j.txHash)}</Ext>}
                  {j.reason && <span className="text-rose-700"> {j.reason}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {exhibits.length > 0 && (
          <details>
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
      </div>
    </Card>
  );
}
