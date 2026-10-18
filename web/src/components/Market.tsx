import { TrendingDown, TrendingUp } from "lucide-react";
import type { DeskState } from "../desk";

export function Market({ state }: { state: DeskState }) {
  return (
    <section aria-label="Market tape" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Market (paper)</span>
      {Object.entries(state.market.tokens).map(([sym, t]) => {
        const move = (t.closePriceUsd / t.priceUsd - 1) * 100;
        const up = move > 0;
        const Icon = up ? TrendingUp : TrendingDown;
        return (
          <span key={sym} className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1 text-sm shadow-sm">
            <span className="font-semibold">{sym}</span>
            {t.staged && <span className="rounded bg-violet-100 px-1 text-[10px] font-semibold uppercase text-violet-800">staged scam</span>}
            <span className={`inline-flex items-center gap-0.5 font-mono text-xs ${up ? "text-emerald-700" : move < 0 ? "text-rose-700" : "text-stone-500"}`}>
              {move !== 0 && <Icon className="h-3.5 w-3.5" />}
              {up ? "+" : ""}
              {move.toFixed(1)}%
            </span>
          </span>
        );
      })}
    </section>
  );
}
