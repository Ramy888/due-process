// Surveillance: deterministic detectors over what the desk recorded (trades written to the ledger, x402 signal sales).
// They run after the fact, so they see what pre-trade checks could not: a signal the trader sold but never declared,
// and small trades that each passed the Chief's auto-approve rule but together break the trader's licence.
import type { Address } from "viem";
import type { MandatePolicy } from "../agents/mandate.js";
import type { RecordedTrade, Signal, SignalSale } from "../store.js";
import type { TraderKey } from "../traders.js";

export type AlertCode = "FRONT_RUNNING" | "SPLIT_TRADES" | "POSITION_LIMIT";

export type Alert = {
  code: AlertCode;
  trader: TraderKey;
  symbol: string;
  /** One plain sentence with the numbers. */
  detail: string;
  trades: RecordedTrade[];
  sales: SignalSale[];
  /** Every trade involved passed on the Chief's auto-approve rule, so no supervisor ever looked at them. */
  unreviewed: boolean;
};

export type SurveillanceInput = {
  trades: RecordedTrade[];
  sales: SignalSale[];
  signals: ReadonlyMap<string, Signal>;
  policies: ReadonlyMap<TraderKey, MandatePolicy>;
  names: Readonly<Record<string, string>>;
  traderOf: (address: Address) => TraderKey | undefined;
  allocationUsd: number;
  autoApproveUsd: number;
  /** Trades this close together count as one order split into pieces. */
  splitWindowMinutes?: number;
};

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
const usd = (n: number) => `$${Math.round(n)}`;
const sum = (ts: RecordedTrade[]) => ts.reduce((s, t) => s + t.notionalUsd, 0);

export function surveil(input: SurveillanceInput): Alert[] {
  return [...frontRunning(input), ...splitTrades(input), ...positionLimits(input)];
}

/** The seller of a signal trades the signal's coin inside its own embargo window after the first sale. */
function frontRunning({ trades, sales, signals, policies, names, traderOf }: SurveillanceInput): Alert[] {
  const alerts: Alert[] = [];
  const bySignal = Map.groupBy(sales, (s) => s.signalId);
  for (const [signalId, signalSales] of bySignal) {
    const signal = signals.get(signalId);
    const seller = traderOf(signalSales[0].sellerAddress);
    if (!signal || !seller) continue;
    const embargo = policies.get(seller)?.signalEmbargoMinutes ?? 0;
    const firstSale = signalSales.map((s) => s.at).sort()[0];
    const ahead = trades.filter(
      (t) => t.trader === seller && t.symbol === signal.symbol && t.side === "buy" && t.at >= firstSale && minutes(firstSale, t.at) <= embargo,
    );
    if (ahead.length === 0) continue;
    alerts.push({
      code: "FRONT_RUNNING",
      trader: seller,
      symbol: signal.symbol,
      detail: `${names[seller]} sold a ${signal.symbol} signal to ${signalSales.length} agent(s), then bought ${signal.symbol} ${ahead.length} time(s) for ${usd(sum(ahead))} inside its ${embargo}-minute embargo.`,
      trades: ahead,
      sales: signalSales,
      unreviewed: ahead.every((t) => t.autoApproved),
    });
  }
  return alerts;
}

/** Several auto-approved buys of one coin, close together, adding up to more than the auto-approve limit. */
function splitTrades({ trades, names, autoApproveUsd, splitWindowMinutes = 15 }: SurveillanceInput): Alert[] {
  const alerts: Alert[] = [];
  const groups = Map.groupBy(
    trades.filter((t) => t.autoApproved && t.side === "buy"),
    (t) => `${t.trader}|${t.symbol}`,
  );
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 0; i < sorted.length; i++) {
      const window = sorted.filter((t) => t.at >= sorted[i].at && minutes(sorted[i].at, t.at) <= splitWindowMinutes);
      if (window.length >= 2 && sum(window) > autoApproveUsd) {
        const t = window[0];
        alerts.push({
          code: "SPLIT_TRADES",
          trader: t.trader,
          symbol: t.symbol,
          detail: `${names[t.trader]} bought ${t.symbol} in ${window.length} pieces totalling ${usd(sum(window))} within ${splitWindowMinutes} minutes; each piece stayed at or under the ${usd(autoApproveUsd)} auto-approve limit, so none was reviewed.`,
          trades: window,
          sales: [],
          unreviewed: true,
        });
        break;
      }
    }
  }
  return alerts;
}

/** A position that grew past the trader's per-coin cap; reports the peak and every trade that built it. */
function positionLimits({ trades, policies, names, allocationUsd }: SurveillanceInput): Alert[] {
  const alerts: Alert[] = [];
  const groups = Map.groupBy(trades, (t) => `${t.trader}|${t.symbol}`);
  for (const group of groups.values()) {
    const { trader, symbol } = group[0];
    const policy = policies.get(trader);
    if (!policy) continue;
    const cap = (policy.maxPositionPctOfAllocation / 100) * allocationUsd;
    let position = 0;
    let peak = 0;
    for (const t of [...group].sort((a, b) => a.at.localeCompare(b.at))) {
      position = Math.max(0, position + (t.side === "buy" ? t.notionalUsd : -t.notionalUsd));
      peak = Math.max(peak, position);
    }
    if (peak <= cap) continue;
    alerts.push({
      code: "POSITION_LIMIT",
      trader,
      symbol,
      detail: `${names[trader]} built a ${usd(peak)} position in ${symbol}; its licence caps one coin at ${usd(cap)} (${policy.maxPositionPctOfAllocation}% of ${usd(allocationUsd)}).`,
      trades: [...group],
      sales: [],
      unreviewed: group.every((x) => x.autoApproved),
    });
  }
  return alerts;
}
