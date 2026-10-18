// Exhibits: the evidence a case is tried on, built deterministically from surveillance alerts and licences.
// Each exhibit has stable facts the court agents read (no ids, hashes or clock times, so a case replays) and refs
// the UI and verifier use (trade ids, x402 nonces, transactions).
import { readFileSync } from "node:fs";
import { describeLimits, type MandatePolicy } from "../agents/mandate.js";
import { DESK } from "../desk.js";
import { ROOT } from "../env.js";
import type { RecordedTrade, SignalSale } from "../store.js";
import { chiefProfile, deskRules, traders, type TraderKey } from "../traders.js";
import type { Alert } from "./surveillance.js";

export type Exhibit = {
  id: string;
  kind: "alert" | "signal-sale" | "trade" | "market" | "licence" | "desk-rule";
  title: string;
  facts: Record<string, unknown>;
  refs: Record<string, string | null>;
};

export type LawReference = { id: string; kind: string; title: string; summary: string; source: string };
export const lawLibrary: readonly LawReference[] = (
  JSON.parse(readFileSync(`${ROOT}data/law/references.json`, "utf8")) as { references: LawReference[] }
).references;

export const CHIEF = "Desk Chief";
const nameOf = (k: TraderKey) => traders.find((t) => t.key === k)?.name ?? k;
/** Coarse timing, so that how fast a run happens (local simulation vs. broadcasts on Base Sepolia) does not change
 *  what the court reads and its answers replay. 15 minutes is well inside the 30-minute signal embargo. */
const within = (minutes: number) => `within ${Math.max(15, Math.ceil(minutes / 15) * 15)} minutes`;

export type MarketPrices = Record<string, { priceUsd: number; closePriceUsd: number }>;

export function buildExhibits(
  alerts: Alert[],
  policies: ReadonlyMap<TraderKey, MandatePolicy>,
  buyerName: (address: string) => string,
  market: MarketPrices,
): Exhibit[] {
  const exhibits: Exhibit[] = [];
  const add = (e: Omit<Exhibit, "id">) => {
    const ex = { id: `E${exhibits.length + 1}`, ...e };
    exhibits.push(ex);
    return ex;
  };

  for (const a of alerts) {
    add({
      kind: "alert",
      title: `Surveillance alert: ${a.code}`,
      facts: {
        code: a.code,
        trader: nameOf(a.trader),
        coin: a.symbol,
        finding: a.detail,
        raised: "by surveillance, after the trades were recorded",
        tradesReviewedByChiefBeforeRecording: !a.unreviewed,
      },
      refs: {},
    });
  }

  const sales = uniqueBy(alerts.flatMap((a) => a.sales), (s) => s.nonce).sort((x, y) => x.at.localeCompare(y.at));
  const trades = uniqueBy(alerts.flatMap((a) => a.trades), (t) => t.tradeId).sort((x, y) => x.at.localeCompare(y.at));
  const start = [...sales.map((s) => s.at), ...trades.map((t) => t.at)].sort()[0];
  const sinceStart = (at: string) => within((Date.parse(at) - Date.parse(start)) / 60_000);

  sales.forEach((s, i) => saleExhibit(add, s, i + 1, buyerName(s.buyerAddress), sinceStart(s.at)));
  trades.forEach((t, i) => tradeExhibit(add, t, i + 1, sinceStart(t.at)));

  for (const symbol of uniqueBy(alerts.map((a) => a.symbol), (s) => s)) {
    const m = market[symbol];
    if (!m) continue;
    const movePct = Math.round((m.closePriceUsd / m.priceUsd - 1) * 1000) / 10;
    const held = trades.filter((t) => t.symbol === symbol && t.side === "buy");
    const gains = Object.entries(Object.groupBy(held, (t) => nameOf(t.trader))).map(([trader, ts]) => {
      const usd = (ts ?? []).reduce((s, t) => s + t.notionalUsd, 0);
      return { trader, boughtUsd: usd, paperGainUsd: Math.round(usd * (m.closePriceUsd / m.priceUsd - 1) * 100) / 100 };
    });
    add({
      kind: "market",
      title: `${symbol} price over the session`,
      facts: { coin: symbol, priceWhenTradedUsd: m.priceUsd, closingPriceUsd: m.closePriceUsd, movePct, paperGains: gains, note: "Paper trading: simulated prices from the scenario's frozen snapshot." },
      refs: {},
    });
  }

  for (const key of uniqueBy(alerts.map((a) => a.trader), (k) => k)) {
    const t = traders.find((x) => x.key === key)!;
    const policy = policies.get(key);
    add({
      kind: "licence",
      title: `${t.name}'s licence`,
      facts: { mandate: t.mandate, deskRules, limits: policy ? describeLimits(policy, DESK.allocationUsd) : [] },
      refs: {},
    });
  }
  add({
    kind: "desk-rule",
    title: "The Desk Chief's licence and standing auto-approve rule",
    facts: {
      mandate: chiefProfile.mandate,
      autoApproveRule: `Cleared trades of $${DESK.autoApproveUsd} or less are recorded without the Chief's review.`,
      setBy: CHIEF,
    },
    refs: {},
  });
  return exhibits;
}

function saleExhibit(add: (e: Omit<Exhibit, "id">) => Exhibit, s: SignalSale, n: number, buyer: string, when: string) {
  add({
    kind: "signal-sale",
    title: `Signal sale ${n}`,
    facts: { order: n, buyer, paidOver: "x402 (test USDC on Base Sepolia)", whenAfterStart: when },
    refs: { signalId: s.signalId, x402Nonce: s.nonce, settlementTx: s.settlementTx, at: s.at },
  });
}

function tradeExhibit(add: (e: Omit<Exhibit, "id">) => Exhibit, t: RecordedTrade, n: number, when: string) {
  add({
    kind: "trade",
    title: `Recorded trade ${n}`,
    facts: { order: n, trader: nameOf(t.trader), coin: t.symbol, side: t.side, usd: t.notionalUsd, approvedBy: t.autoApproved ? "auto-approve rule (no review)" : CHIEF, whenAfterStart: when },
    refs: { tradeId: t.tradeId, clearanceId: t.clearanceId, txHash: t.txHash, at: t.at },
  });
}

function uniqueBy<T, K>(items: T[], key: (t: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
}

/** What the court agents see: exhibits without refs. */
export const forCourt = (exhibits: Exhibit[]) => exhibits.map(({ id, kind, title, facts }) => ({ id, kind, title, facts }));
