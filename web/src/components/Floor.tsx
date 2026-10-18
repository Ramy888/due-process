import { useState } from "react";
import { short, txUrl, usd, type BeatCard, type BeatItem, type DeskState } from "../desk";
import { Badge, Card, Ext, Mono, verdictTone, type Tone } from "./ui";

const CHIEF_TONE: Record<string, Tone> = { approved: "green", "auto-approved": "blue", refused: "red", blocked: "gray", "cosign-declined": "amber", "rejected-by-ledger": "red" };
const CHIEF_LABEL: Record<string, string> = {
  approved: "Chief approved (signed)",
  "auto-approved": "Auto-approved, no review",
  refused: "Chief refused (signed)",
  blocked: "Not reviewed: clearance blocked it",
  "cosign-declined": "You declined to co-sign",
  "rejected-by-ledger": "DeskLedger rejected it",
};

function Item({ item, state }: { item: BeatItem; state: DeskState }) {
  const [showLog, setShowLog] = useState(false);
  const traderName = (key: string) => state.traders.find((t) => t.key === key)?.name ?? key;
  const byAddress = (a: string) => state.traders.find((t) => t.address.toLowerCase() === a.toLowerCase())?.name ?? short(a);
  switch (item.type) {
    case "decision":
      return (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{traderName(item.trader)}</strong>
            {item.decision.action === "pass" ? (
              <Badge>passes</Badge>
            ) : (
              <span>
                proposes <strong>{item.decision.side.toUpperCase()} {item.decision.symbol} {usd(item.decision.notionalUsd)}</strong>
              </span>
            )}
            {item.staged && <Badge tone="violet">STAGED misconduct</Badge>}
          </div>
          <p className="mt-1 text-sm text-stone-600">{item.decision.reasoning}</p>
        </div>
      );
    case "signal":
      return (
        <p className="text-sm">
          <Badge tone="violet">x402 signal sale</Badge> {byAddress(item.buyer)} paid $0.05 for a {item.symbol} tip.
        </p>
      );
    case "clearance":
      return (
        <div className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>Pre-trade clearance: Chainlink CRE workflow, paid $0.01 over x402</span>
            {item.verdict ? <Badge tone={verdictTone(item.verdict)}>{item.verdict}</Badge> : item.failed ? <Badge tone="red">failed</Badge> : <Badge>running…</Badge>}
          </div>
          {item.hits && item.hits.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-stone-600">
              {item.hits.map((h) => (
                <li key={h.code}>
                  <Mono>{h.code}</Mono>: {h.detail}
                </li>
              ))}
            </ul>
          )}
          {item.failed && <p className="mt-1 text-rose-700">{item.failed}</p>}
          {item.lines.length > 0 && (
            <button onClick={() => setShowLog(!showLog)} className="mt-1 text-xs text-court underline decoration-stone-300 underline-offset-2">
              {showLog ? "Hide" : "Show"} CRE simulation log ({item.lines.length} lines)
            </button>
          )}
          {showLog && <pre className="mt-1 max-h-56 overflow-auto rounded bg-stone-900 p-2 text-[11px] leading-snug text-stone-100">{item.lines.join("\n")}</pre>}
        </div>
      );
    case "cosign":
      return (
        <p className="text-sm">
          <Badge tone={item.decided ? (item.approved ? "green" : "amber") : "amber"}>
            {item.decided ? (item.approved ? "you co-signed" : "you declined") : "waiting for your co-signature"}
          </Badge>{" "}
          {usd(item.notionalUsd)} {item.symbol} is above the co-sign threshold.
        </p>
      );
    case "chief":
      return (
        <div className="text-sm">
          <Badge tone={CHIEF_TONE[item.outcome] ?? "gray"}>{CHIEF_LABEL[item.outcome] ?? item.outcome}</Badge>
          <p className="mt-1 text-stone-700">{item.reason}</p>
          {item.concerns.length > 0 && <p className="mt-0.5 text-xs text-stone-500">Concerns: {item.concerns.join("; ")}</p>}
        </div>
      );
    case "ledger":
      return (
        <p className="text-sm">
          <Badge tone={item.recorded ? (item.mode === "ledger" ? "green" : "gray") : "red"}>
            {item.kind} {item.recorded ? (item.mode === "ledger" ? "recorded on DeskLedger" : "encoded (local simulation)") : "not recorded"}
          </Badge>{" "}
          {item.txHash && <Ext href={txUrl(item.txHash)}>verify on-chain {short(item.txHash)}</Ext>}
          {item.reason && <span className="text-rose-700"> {item.reason}</span>}
        </p>
      );
  }
}

export function Floor({ beats, state }: { beats: BeatCard[]; state: DeskState }) {
  if (beats.length === 0) {
    return (
      <Card title="Desk floor">
        <p className="text-sm text-stone-600">Nothing has happened yet. Run the scenario to watch five AI traders, their Desk Chief and the court.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {beats.map((b) => (
        <Card key={b.id} title={b.title} aside={b.done ? <span>trail <Mono>{b.trailHead ? short(b.trailHead) : ""}</Mono></span> : "in progress"}>
          <ol className="space-y-3 border-l-2 border-stone-100 pl-4">
            {b.items.map((item, i) => (
              <li key={i} className="relative">
                <span className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full bg-stone-300" />
                <Item item={item} state={state} />
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
