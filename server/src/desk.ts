// Desk parameters set at deploy time (contracts/script/Deploy.s.sol). Paper US dollars.
export const DESK = {
  budgetUsd: 10_000,
  allocationUsd: 2_000,
  autoApproveUsd: 100,
  coSignUsd: 150,
  /** ACE MaxPolicy ceiling per trade, enforced on-chain. */
  maxTradeUsd: 1_500,
  /** Test USDC each licensee posts as bond; a judgment can slash up to this. */
  bondUsd: 1,
} as const;

/** Paper positions and spend per trader, as recorded by the ledger. */
export class DeskBook {
  private readonly spent = new Map<string, number>();
  private readonly trades = new Map<string, number>();
  private readonly holdings = new Map<string, Record<string, number>>();

  record(trader: string, symbol: string, side: "buy" | "sell", usd: number): void {
    const h = { ...(this.holdings.get(trader) ?? {}) };
    const sign = side === "buy" ? 1 : -1;
    h[symbol] = Math.max(0, (h[symbol] ?? 0) + sign * usd);
    if (h[symbol] === 0) delete h[symbol];
    this.holdings.set(trader, h);
    this.spent.set(trader, Math.max(0, (this.spent.get(trader) ?? 0) + sign * usd));
    this.trades.set(trader, (this.trades.get(trader) ?? 0) + 1);
  }

  /** Trades recorded this session (a scenario plays out within one hour). */
  tradeCount(trader: string): number {
    return this.trades.get(trader) ?? 0;
  }

  spentUsd(trader: string): number {
    return this.spent.get(trader) ?? 0;
  }

  holdingsUsd(trader: string): Record<string, number> {
    return { ...(this.holdings.get(trader) ?? {}) };
  }

  /** Every trader's holdings, for the Chief's desk-wide view. */
  all(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.holdings].map(([k, v]) => [k, { ...v }]));
  }
}

/** Paper profit or loss: every position filled at the session price and is marked at the closing price. */
export function paperPnlUsd(holdingsUsd: Record<string, number>, tokens: Record<string, { priceUsd: number; closePriceUsd: number }>): number {
  return Object.entries(holdingsUsd).reduce((sum, [symbol, usd]) => {
    const t = tokens[symbol];
    return t ? sum + usd * (t.closePriceUsd / t.priceUsd - 1) : sum;
  }, 0);
}
