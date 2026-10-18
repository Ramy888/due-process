import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleDollarSign } from "lucide-react";
import { firstSentence, short, txUrl, usd, type BeatCard, type DeskState, type Trade } from "../desk";
import { Avatar } from "./Avatar";
import { GateRow, gatesFor } from "./Gates";
import { Badge, Ext, Mono, verdictTone } from "./ui";

/** Everything behind "Why?": the trader's reasoning, the check's findings and log, the Chief's reasons, the records. */
function Details({ t }: { t: Trade }) {
  const [log, setLog] = useState(false);
  const c = t.clearance;
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-stone-50 p-3 text-sm">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">Trader's reasoning</div>
        <p className="mt-1 text-stone-700">{t.decision.reasoning}</p>
        {t.decision.evidence.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {t.decision.evidence.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </div>
        )}
      </div>
      {c && (
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Chainlink check {c.verdict && <Badge tone={verdictTone(c.verdict)}>{c.verdict}</Badge>}
          </div>
          {c.hits && c.hits.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-stone-700">
              {c.hits.map((h) => (
                <li key={h.code}>
                  <Mono className="text-stone-500">{h.code}</Mono> {h.detail}
                </li>
              ))}
            </ul>
          ) : c.verdict === "CLEARED" ? (
            <p className="mt-1 text-stone-600">No risk rule fired.</p>
          ) : null}
          {c.failed && <p className="mt-1 text-rose-700">{c.failed}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
            {c.txHash && <Ext href={txUrl(c.txHash)}>verdict on-chain {short(c.txHash)}</Ext>}
            {c.lines.length > 0 && (
              <button onClick={() => setLog(!log)} className="text-court underline decoration-stone-300 underline-offset-2">
                {log ? "Hide" : "Show"} CRE workflow log
              </button>
            )}
          </div>
          {log && <pre className="mt-2 max-h-56 overflow-auto rounded bg-stone-900 p-2 text-[11px] leading-snug text-stone-100">{c.lines.join("\n")}</pre>}
        </div>
      )}
      {t.chief && t.chief.outcome !== "blocked" && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">Desk Chief</div>
          <p className="mt-1 text-stone-700">{t.chief.reason}</p>
          {t.chief.concerns.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-stone-500">
              {t.chief.concerns.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {t.ledger?.txHash && (
        <div className="text-xs">
          <Ext href={txUrl(t.ledger.txHash)}>
            {t.ledger.kind} on-chain {short(t.ledger.txHash)}
          </Ext>
        </div>
      )}
    </div>
  );
}

function TradeLine({ t, label }: { t: Trade; label?: string }) {
  const [open, setOpen] = useState(false);
  const d = t.decision;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {label && <span className="text-xs font-semibold text-stone-500">{label}</span>}
        <span className={`${label ? "text-base" : "text-lg"} font-semibold tracking-tight text-stone-900`}>
          {d.side === "buy" ? "Buy" : "Sell"} {d.symbol} {usd(d.notionalUsd)}
        </span>
      </div>
      {!label && <p className="mt-1 text-sm italic text-stone-600">“{firstSentence(d.reasoning)}”</p>}
      <div className="mt-3">
        <GateRow gates={gatesFor(t)} compact={!!label} />
      </div>
      <button onClick={() => setOpen(!open)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-court">
        Why? <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <Details t={t} />}
    </div>
  );
}

function Beat({ beat, state }: { beat: BeatCard; state: DeskState }) {
  const trader = state.traders.find((t) => t.key === beat.trader);
  const nameOf = (address: string) => state.traders.find((t) => t.address.toLowerCase() === address.toLowerCase())?.name ?? short(address);
  const staged = beat.trades.some((t) => t.staged);
  const passed = beat.trades.length === 1 && beat.trades[0].decision.action === "pass";
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <header className="flex items-start gap-3">
        <Avatar agent={beat.trader} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{trader?.name ?? beat.trader}</span>
            {staged && <Badge tone="violet">STAGED misconduct</Badge>}
            {!beat.done && <Badge tone="blue">live</Badge>}
          </div>
          <h3 className="font-serif text-base text-stone-600">{beat.title}</h3>
        </div>
      </header>

      {beat.signals.length > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <CircleDollarSign className="h-4 w-4 shrink-0" />
          Sold a {beat.signals[0].symbol} tip to {beat.signals.map((s) => nameOf(s.buyer)).join(" and ")} for $0.05 each, over x402.
        </p>
      )}

      <div className="mt-3 space-y-4">
        {passed ? (
          <p className="text-sm text-stone-600">
            <Badge>passes</Badge> <span className="italic">“{firstSentence(beat.trades[0].decision.reasoning)}”</span>
          </p>
        ) : beat.trades.length > 1 ? (
          <>
            <p className="text-sm text-stone-600">
              Then buys {beat.trades[0].decision.symbol} in {beat.trades.length} small pieces, each at or under the Chief's{" "}
              {usd(state.desk.autoApproveUsd)} auto-approve line:
            </p>
            <div className="grid gap-3 @2xl:grid-cols-3">
              {beat.trades.map((t, i) => (
                <div key={i} className="rounded-xl border border-stone-100 bg-stone-50/60 p-3">
                  <TradeLine t={t} label={`Piece ${i + 1}`} />
                </div>
              ))}
            </div>
          </>
        ) : (
          beat.trades.map((t, i) => <TradeLine key={i} t={t} />)
        )}
      </div>
    </article>
  );
}

/** The trades panel beside the desk map. During a live run it follows the newest trade, unless the reader scrolled up. */
export function Floor({ beats, state, follow }: { beats: BeatCard[]; state: DeskState; follow: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (beats.length === 0) pinned.current = true;
    else if (follow && pinned.current) el.scrollTop = el.scrollHeight;
  }, [beats, follow]);
  const onScroll = () => {
    const el = box.current!;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const trades = beats.reduce((n, b) => n + b.trades.filter((t) => t.decision.action === "trade").length, 0);

  return (
    <section aria-label="Trades" className="flex min-h-0 flex-col">
      <h2 className="mb-2 flex items-baseline justify-between gap-2 px-1 font-serif text-lg font-semibold text-court">
        Trades <span className="font-sans text-xs font-normal text-stone-500">{trades} proposed</span>
      </h2>
      <div ref={box} onScroll={onScroll} className="@container max-h-[75vh] min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain lg:max-h-none">
        {beats.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-8 text-center text-sm text-stone-600">
            Press <strong>Run the scenario</strong> to watch five AI traders, their Desk Chief and the court.
          </div>
        ) : (
          beats.map((b) => <Beat key={b.id} beat={b} state={state} />)
        )}
      </div>
    </section>
  );
}
