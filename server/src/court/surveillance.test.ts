import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { MandatePolicy } from "../agents/mandate.js";
import type { RecordedTrade, Signal, SignalSale } from "../store.js";
import type { TraderKey } from "../traders.js";
import { surveil, type SurveillanceInput } from "./surveillance.js";

const MEME = "0x000000000000000000000000000000000000000e" as Address;
const KOL = "0x000000000000000000000000000000000000000b" as Address;
const at = (min: number) => new Date(Date.parse("2026-10-18T12:00:00Z") + min * 60_000).toISOString();

const policy = (cap: number, embargo: number): MandatePolicy => ({
  maxTradeUsd: 150,
  maxPositionPctOfAllocation: cap,
  minLiquidityUsd: 0,
  allowedChains: ["solana"],
  deniedTokens: [],
  maxTradesPerHour: 6,
  signalEmbargoMinutes: embargo,
});

let n = 0;
const trade = (trader: TraderKey, symbol: string, usd: number, min: number, autoApproved = true): RecordedTrade => ({
  tradeId: `0x${(++n).toString(16).padStart(64, "0")}` as Hex,
  runId: "run-1",
  beatId: "b",
  clearanceId: `0x${"c".repeat(64)}` as Hex,
  trader,
  traderAddress: trader === "TRADER_MEME" ? MEME : KOL,
  symbol,
  side: "buy",
  notionalUsd: usd,
  autoApproved,
  txHash: null,
  at: at(min),
});
const signal: Signal = { id: "sig", runId: "run-1", seller: "Meme Hunter", sellerAddress: MEME, symbol: "POPCAT", text: "tip", priceUsd: 0.05, createdAt: at(0) };
const sale = (buyer: Address, min: number): SignalSale => ({ nonce: `0x${"d".repeat(64)}` as Hex, signalId: "sig", buyerAddress: buyer, sellerAddress: MEME, at: at(min), settlementTx: null });

function input(trades: RecordedTrade[], sales: SignalSale[] = []): SurveillanceInput {
  return {
    trades,
    sales,
    signals: new Map([["sig", signal]]),
    policies: new Map<TraderKey, MandatePolicy>([["TRADER_MEME", policy(5, 30)], ["TRADER_KOL", policy(10, 30)]]),
    names: { TRADER_MEME: "Meme Hunter", TRADER_KOL: "KOL Narrative" },
    traderOf: (a) => (a === MEME ? "TRADER_MEME" : a === KOL ? "TRADER_KOL" : undefined),
    allocationUsd: 2000,
    autoApproveUsd: 100,
  };
}

describe("surveillance", () => {
  it("catches the Meme Hunter's scheme: front-running its own signal, split into unreviewed pieces, over its position cap", () => {
    const pieces = [trade("TRADER_MEME", "POPCAT", 90, 2), trade("TRADER_MEME", "POPCAT", 90, 3), trade("TRADER_MEME", "POPCAT", 90, 4)];
    const alerts = surveil(input(pieces, [sale(KOL, 0), sale(KOL, 1)]));
    expect(alerts.map((a) => a.code)).toEqual(["FRONT_RUNNING", "SPLIT_TRADES", "POSITION_LIMIT"]);
    expect(alerts.every((a) => a.trader === "TRADER_MEME" && a.unreviewed)).toBe(true);
    expect(alerts[0].detail).toBe("Meme Hunter sold a POPCAT signal to 2 agent(s), then bought POPCAT 3 time(s) for $270 inside its 30-minute embargo.");
    expect(alerts[1].trades).toHaveLength(3);
    expect(alerts[2].detail).toContain("$270 position in POPCAT; its licence caps one coin at $100");
    expect(alerts[2].trades).toHaveLength(3);
  });

  it("leaves trading after the embargo, or before the sale, alone", () => {
    const later = surveil(input([trade("TRADER_MEME", "POPCAT", 90, 31)], [sale(KOL, 0)]));
    const before = surveil(input([trade("TRADER_MEME", "POPCAT", 90, 0)], [sale(KOL, 5)]));
    expect(later.map((a) => a.code)).not.toContain("FRONT_RUNNING");
    expect(before.map((a) => a.code)).not.toContain("FRONT_RUNNING");
  });

  it("does not flag a single small trade, pieces spread far apart, or reviewed trades as splitting", () => {
    expect(surveil(input([trade("TRADER_MEME", "POPCAT", 90, 0)]))).toEqual([]);
    expect(surveil(input([trade("TRADER_MEME", "POPCAT", 60, 0), trade("TRADER_MEME", "POPCAT", 60, 40)])).map((a) => a.code)).toEqual(["POSITION_LIMIT"]);
    expect(surveil(input([trade("TRADER_KOL", "WIF", 90, 0, false), trade("TRADER_KOL", "WIF", 90, 1, false)])).map((a) => a.code)).toEqual([]);
  });

  it("marks a breach the Chief reviewed as reviewed", () => {
    const [alert] = surveil(input([trade("TRADER_MEME", "POPCAT", 150, 0, false)]));
    expect(alert).toMatchObject({ code: "POSITION_LIMIT", unreviewed: false });
  });
});
