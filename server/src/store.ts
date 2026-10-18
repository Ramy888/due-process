// Durable desk state (node:sqlite). Trails live here so a case can be verified and replayed after a restart.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Trail, type TrailEntry } from "./agents/trail.js";
import { emit } from "./bus.js";
import { ROOT } from "./env.js";
import type { Address, Hex } from "viem";
import type { TraderKey } from "./traders.js";

export type Signal = { id: string; runId: string; seller: string; sellerAddress: Address; symbol: string; text: string; priceUsd: number; createdAt: string };
export type SignalSale = { nonce: Hex; signalId: string; buyerAddress: Address; sellerAddress: Address; at: string; settlementTx: Hex | null };
export type RecordedTrade = {
  tradeId: Hex;
  runId: string;
  beatId: string;
  clearanceId: Hex;
  trader: TraderKey;
  traderAddress: Address;
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  autoApproved: boolean;
  /** Base Sepolia transaction when written in ledger mode; null in local simulation. */
  txHash: Hex | null;
  at: string;
};

export const defaultStorePath = () => process.env.DESK_DB ?? `${ROOT}data/runtime/desk.sqlite`;

export class DeskStore {
  private readonly db: DatabaseSync;

  constructor(path: string = defaultStorePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS trail_entries (
      trail_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (trail_id, seq))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seller TEXT NOT NULL, seller_address TEXT NOT NULL, symbol TEXT NOT NULL, text TEXT NOT NULL,
      price_usd REAL NOT NULL, created_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS signal_sales (
      nonce TEXT PRIMARY KEY, signal_id TEXT NOT NULL, buyer_address TEXT NOT NULL, seller_address TEXT NOT NULL,
      at TEXT NOT NULL, settlement_tx TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS desk_trades (
      trade_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, beat_id TEXT NOT NULL, clearance_id TEXT NOT NULL, trader TEXT NOT NULL,
      trader_address TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, notional_usd REAL NOT NULL,
      auto_approved INTEGER NOT NULL, tx_hash TEXT, at TEXT NOT NULL)`);
  }

  putSignal(sig: Signal): void {
    this.db
      .prepare("INSERT INTO signals (id, run_id, seller, seller_address, symbol, text, price_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sig.id, sig.runId, sig.seller, sig.sellerAddress, sig.symbol, sig.text, sig.priceUsd, sig.createdAt);
  }

  signal(id: string): Signal | undefined {
    const r = this.db.prepare("SELECT * FROM signals WHERE id = ?").get(id);
    return r
      ? { id: String(r.id), runId: String(r.run_id), seller: String(r.seller), sellerAddress: String(r.seller_address) as Address, symbol: String(r.symbol), text: String(r.text), priceUsd: Number(r.price_usd), createdAt: String(r.created_at) }
      : undefined;
  }

  /** Recorded by the paid route once the payment is verified; the settlement tx is attached when the buyer sees it. */
  recordSale(sale: Omit<SignalSale, "settlementTx">): void {
    this.db
      .prepare("INSERT INTO signal_sales (nonce, signal_id, buyer_address, seller_address, at) VALUES (?, ?, ?, ?, ?)")
      .run(sale.nonce, sale.signalId, sale.buyerAddress, sale.sellerAddress, sale.at);
  }

  /** A buyer buys a given signal once, so (signal, buyer) names the sale. */
  attachSettlement(signalId: string, buyer: Address, tx: Hex): void {
    this.db.prepare("UPDATE signal_sales SET settlement_tx = ? WHERE signal_id = ? AND buyer_address = ?").run(tx, signalId, buyer);
  }

  /** Signal sales, optionally only for signals offered in one run. */
  sales(runId?: string): SignalSale[] {
    const rows = runId
      ? this.db.prepare("SELECT s.* FROM signal_sales s JOIN signals g ON g.id = s.signal_id WHERE g.run_id = ? ORDER BY s.at").all(runId)
      : this.db.prepare("SELECT * FROM signal_sales ORDER BY at").all();
    return rows
      .map((r) => ({
        nonce: String(r.nonce) as Hex,
        signalId: String(r.signal_id),
        buyerAddress: String(r.buyer_address) as Address,
        sellerAddress: String(r.seller_address) as Address,
        at: String(r.at),
        settlementTx: r.settlement_tx == null ? null : (String(r.settlement_tx) as Hex),
      }));
  }

  recordTrade(t: RecordedTrade): void {
    this.db
      .prepare(
        `INSERT INTO desk_trades (trade_id, run_id, beat_id, clearance_id, trader, trader_address, symbol, side, notional_usd, auto_approved, tx_hash, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.tradeId, t.runId, t.beatId, t.clearanceId, t.trader, t.traderAddress, t.symbol, t.side, t.notionalUsd, t.autoApproved ? 1 : 0, t.txHash, t.at);
  }

  /** Recorded trades, optionally only for one run. */
  trades(runId?: string): RecordedTrade[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM desk_trades WHERE run_id = ? ORDER BY at").all(runId)
      : this.db.prepare("SELECT * FROM desk_trades ORDER BY at").all();
    return rows
      .map((r) => ({
        tradeId: String(r.trade_id) as Hex,
        runId: String(r.run_id),
        beatId: String(r.beat_id),
        clearanceId: String(r.clearance_id) as Hex,
        trader: String(r.trader) as TraderKey,
        traderAddress: String(r.trader_address) as Address,
        symbol: String(r.symbol),
        side: String(r.side) as "buy" | "sell",
        notionalUsd: Number(r.notional_usd),
        autoApproved: Number(r.auto_approved) === 1,
        txHash: r.tx_hash == null ? null : (String(r.tx_hash) as Hex),
        at: String(r.at),
      }));
  }

  /** Opens (or starts) a trail; each new entry is stored, then announced on the bus. */
  openTrail(id: string): Trail {
    return new Trail(id, this.trailEntries(id), (entry) => {
      this.db
        .prepare("INSERT INTO trail_entries (trail_id, seq, hash, json) VALUES (?, ?, ?, ?)")
        .run(entry.trailId, entry.seq, entry.hash, JSON.stringify(entry));
      emit({ type: "trail.entry", entry });
    });
  }

  trailEntries(id: string): TrailEntry[] {
    return this.db
      .prepare("SELECT json FROM trail_entries WHERE trail_id = ? ORDER BY seq")
      .all(id)
      .map((row) => JSON.parse(String(row.json)) as TrailEntry);
  }

  trailIds(): string[] {
    return this.db
      .prepare("SELECT DISTINCT trail_id FROM trail_entries ORDER BY trail_id")
      .all()
      .map((row) => String(row.trail_id));
  }

  close(): void {
    this.db.close();
  }
}
