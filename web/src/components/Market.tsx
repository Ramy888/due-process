import { TrendingDown, TrendingUp } from "lucide-react";
import type { DeskState } from "../desk";

export function Market({ state }: { state: DeskState }) {
  return (
    <section aria-label="Market tape" className="text-center">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">Market (paper)</div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {Object.entries(state.market.tokens).map(([sym, t]) => {
          const move = (t.closePriceUsd / t.priceUsd - 1) * 100;
          const up = move > 0;
          const Icon = up ? TrendingUp : TrendingDown;
          return (
            <span key={sym} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-white">
              <span className="font-semibold">{sym}</span>
              {t.staged && <span className="rounded bg-violet-400/25 px-1 text-[10px] font-semibold uppercase text-violet-200">staged scam</span>}
              <span className={`inline-flex items-center gap-0.5 font-mono ${up ? "text-emerald-300" : move < 0 ? "text-rose-300" : "text-white/50"}`}>
                {move !== 0 && <Icon className="h-3 w-3" />}
                {up ? "+" : ""}
                {move.toFixed(1)}%
              </span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
