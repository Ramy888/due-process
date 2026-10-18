import type { DeskState } from "../desk";
import { Badge, Card } from "./ui";

export function Market({ state }: { state: DeskState }) {
  return (
    <Card title="Market tape" aside={state.market.label}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-stone-500">
          <tr>
            <th className="pb-2 font-medium">Coin</th>
            <th className="pb-2 font-medium">Pool</th>
            <th className="pb-2 text-right font-medium whitespace-nowrap">Traded at</th>
            <th className="pb-2 text-right font-medium">Close</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {Object.entries(state.market.tokens).map(([sym, t]) => {
            const move = (t.closePriceUsd / t.priceUsd - 1) * 100;
            return (
              <tr key={sym}>
                <td className="py-2">
                  <div className="font-medium">{sym}</div>
                  <div className="text-xs text-stone-500">{t.chain === "solana" ? "Solana · real token" : "Base Sepolia"}</div>
                  {t.staged && (
                    <div className="mt-0.5">
                      <Badge tone="violet">staged scam</Badge>
                    </div>
                  )}
                </td>
                <td className="py-2 text-stone-600">${(t.liquidityUsd / 1e6).toFixed(2)}M</td>
                <td className="py-2 text-right font-mono text-xs">${t.priceUsd}</td>
                <td className={`py-2 text-right font-mono text-xs ${move > 0 ? "text-emerald-700" : move < 0 ? "text-rose-700" : ""}`}>
                  ${t.closePriceUsd} ({move > 0 ? "+" : ""}
                  {move.toFixed(1)}%)
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
