// Client side of the desk server: the /state snapshot (polled) and the /events stream folded into the desk floor
// (one card per scenario beat) and the courtroom.
import { useEffect, useReducer, useState } from "react";

export type Verdict = "CLEARED" | "FLAGGED" | "BLOCKED";
export type Hit = { code: string; severity: string; detail: string };
export type Decision = { action: "trade" | "pass"; symbol: string; side: "buy" | "sell"; notionalUsd: number; reasoning: string; evidence: string[] };

export type TraderState = {
  key: string;
  name: string;
  watches: string;
  mandate: string;
  address: string;
  bondUsd: number;
  licence: "active" | "suspended";
  allocationUsd: number;
  spentUsd: number;
  holdingsUsd: Record<string, number>;
  pnlUsd: number;
  approved: number;
  autoApproved: number;
  refused: number;
  rejectedByLedger: number;
  clearanceFeesUsd: number;
  signalsBoughtUsd: number;
  signalIncomeUsd: number;
};

export type Token = { chain: string; priceUsd: number; closePriceUsd: number; liquidityUsd: number; change24hPct: number; staged?: boolean };

export type Approval =
  | { kind: "cosign"; id: string; request: { beatId: string; trader: string; symbol: string; notionalUsd: number; reason: string } }
  | { kind: "sanctions"; id: string; request: { summary: string; sanctions: Sanction[] } };
export type Sanction = { defendant: string; slashUsd: number; suspendLicence: boolean; revokeAutoApprove: boolean; rationale: string };

export type DeskState = {
  run: { runId: string | null; scenarioId: string | null; status: "idle" | "running" | "finished" | "failed"; error: string | null };
  desk: {
    budgetUsd: number;
    allocationUsd: number;
    autoApproveUsd: number;
    coSignUsd: number;
    maxTradeUsd: number;
    bondUsd: number;
    paymentsMode: "x402" | "offline";
    ledgerMode: "local-simulation" | "ledger";
    autoApproveRevoked: boolean;
  };
  market: { label: string; tokens: Record<string, Token> };
  traders: TraderState[];
  chief: { name: string; mandate: string; bondUsd: number; licence: string };
  approvals: Approval[];
};

export function useDeskState(intervalMs = 1500): DeskState | null {
  const [state, setState] = useState<DeskState | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/state")
        .then((r) => r.json())
        .then((s) => live && setState(s))
        .catch(() => undefined);
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return state;
}

/** Human-only actions; the custom header is what the server checks. */
export async function deskPost(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-desk-ui": "1" }, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------- the event stream

/** One proposed trade and what each gate did with it: fee, Chainlink check, Desk Chief, you, the ledger. */
export type Trade = {
  decision: Decision;
  staged: boolean;
  clearance?: { clearanceId: string; lines: string[]; verdict?: Verdict; hits?: Hit[]; log?: string; failed?: string; txHash?: string | null };
  chief?: { outcome: string; reason: string; concerns: string[] };
  cosign?: { id: string; state: "pending" | "approved" | "declined" };
  ledger?: { kind: string; mode: string; txHash: string | null; recorded: boolean; reason: string | null; log: string };
};

export type BeatCard = {
  id: string;
  title: string;
  trader: string;
  trades: Trade[];
  /** x402 signal sales made in this beat (buyer address). */
  signals: { buyer: string; symbol: string }[];
  done: boolean;
  trailId?: string;
  trailHead?: string;
};

export type TrailEntry = { trailId: string; seq: number; at: string; agent: string; kind: string; data: any; prevHash: string; hash: string };

export type Courtroom = {
  alerts: { code: string; trader: string; symbol: string; detail: string; unreviewed: boolean }[];
  entries: TrailEntry[];
  decided?: { summary: string; approved: boolean; caseHash: string };
  judgments: { kind: string; txHash: string | null; recorded: boolean; reason: string | null; mode: string }[];
};

export type Floor = { runId: string | null; finished: boolean; error?: string; beats: BeatCard[]; court: Courtroom };

const empty = (): Floor => ({ runId: null, finished: false, beats: [], court: { alerts: [], entries: [], judgments: [] } });

type Ev = { type: string; [k: string]: any };

const onLastBeat = (floor: Floor, f: (b: BeatCard) => BeatCard): Floor =>
  floor.beats.length === 0 ? floor : { ...floor, beats: [...floor.beats.slice(0, -1), f(floor.beats[floor.beats.length - 1])] };

const onLastTrade = (floor: Floor, f: (t: Trade) => Trade): Floor =>
  onLastBeat(floor, (b) => (b.trades.length === 0 ? b : { ...b, trades: [...b.trades.slice(0, -1), f(b.trades[b.trades.length - 1])] }));

const onTrade = (floor: Floor, match: (t: Trade) => boolean, f: (t: Trade) => Trade): Floor => ({
  ...floor,
  beats: floor.beats.map((b) => ({ ...b, trades: b.trades.map((t) => (match(t) ? f(t) : t)) })),
});

const byClearance = (id: string) => (t: Trade) => t.clearance?.clearanceId === id;

export function reduceFloor(floor: Floor, e: Ev): Floor {
  switch (e.type) {
    case "scenario.started":
      return { ...empty(), runId: e.runId };
    case "scenario.finished":
      return { ...floor, finished: true, error: e.error };
    case "beat.started":
      return { ...floor, beats: [...floor.beats, { id: e.beatId, title: e.title, trader: e.trader, trades: [], signals: [], done: false }] };
    case "beat.finished":
      return { ...floor, beats: floor.beats.map((b) => (b.id === e.beatId ? { ...b, done: true, trailId: e.trailId, trailHead: e.trailHead } : b)) };
    case "trader.decision":
      return onLastBeat(floor, (b) => ({ ...b, trades: [...b.trades, { decision: e.decision, staged: !!e.staged }] }));
    case "signal.sold":
      return onLastBeat(floor, (b) => ({ ...b, signals: [...b.signals, { buyer: e.buyer, symbol: e.symbol }] }));
    case "clearance.started":
      return onLastTrade(floor, (t) => ({ ...t, clearance: { clearanceId: e.clearanceId, lines: [] } }));
    case "cre.line":
      return onTrade(floor, byClearance(e.clearanceId), (t) => ({ ...t, clearance: { ...t.clearance!, lines: [...t.clearance!.lines, e.line] } }));
    case "clearance.result":
      return onTrade(floor, byClearance(e.result.clearanceId), (t) => ({
        ...t,
        clearance: { ...t.clearance!, verdict: e.result.verdict, hits: e.result.hits, log: e.log, txHash: e.result.txHash },
      }));
    case "clearance.failed":
      return onTrade(floor, byClearance(e.clearanceId), (t) => ({ ...t, clearance: { ...t.clearance!, failed: e.error } }));
    case "approval.requested":
      return e.kind === "cosign" ? onLastTrade(floor, (t) => ({ ...t, cosign: { id: e.id, state: "pending" } })) : floor;
    case "approval.decided":
      return onTrade(floor, (t) => t.cosign?.id === e.id, (t) => ({ ...t, cosign: { id: e.id, state: e.approved ? "approved" : "declined" } }));
    case "chief.decision":
      // a declined co-signature arrives as a later Chief event; keep the Chief's own approval and mark the human's "no"
      if (e.outcome === "cosign-declined") return onLastTrade(floor, (t) => ({ ...t, cosign: { id: t.cosign?.id ?? "", state: "declined" } }));
      return onLastTrade(floor, (t) => ({ ...t, chief: { outcome: e.outcome, reason: e.reason, concerns: e.concerns } }));
    case "ledger.write":
      if (e.beatId === "court") return { ...floor, court: { ...floor.court, judgments: [...floor.court.judgments, e as any] } };
      return onLastTrade(floor, (t) => ({ ...t, ledger: { kind: e.kind, mode: e.mode, txHash: e.txHash, recorded: e.recorded, reason: e.reason, log: e.log } }));
    case "surveillance.alerts":
      return { ...floor, court: { ...floor.court, alerts: e.alerts } };
    case "case.decided":
      return { ...floor, court: { ...floor.court, decided: { summary: e.summary, approved: e.approved, caseHash: e.caseHash } } };
    case "trail.entry": {
      const entry = e.entry as TrailEntry;
      if (entry.kind.startsWith("case.") || entry.kind.startsWith("sanctions.")) return { ...floor, court: { ...floor.court, entries: [...floor.court.entries, entry] } };
      return floor;
    }
    default:
      return floor;
  }
}

export const EVENT_TYPES = [
  "scenario.started", "scenario.finished", "beat.started", "beat.finished", "trader.decision", "signal.sold",
  "clearance.started", "cre.line", "clearance.result", "clearance.failed", "approval.requested", "approval.decided",
  "chief.decision", "ledger.write", "surveillance.alerts", "case.decided", "trail.entry",
];

export function useDeskFloor(): Floor {
  const [floor, dispatch] = useReducer(reduceFloor, undefined, empty);
  useEffect(() => {
    const es = new EventSource("/events");
    const on = (m: MessageEvent) => dispatch(JSON.parse(m.data));
    for (const t of EVENT_TYPES) es.addEventListener(t, on);
    return () => es.close();
  }, []);
  return floor;
}

// ---------------------------------------------------------------- formatting

export const usd = (n: number, digits = 0) => `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const short = (h: string, n = 6) => `${h.slice(0, n + 2)}…${h.slice(-4)}`;
export const txUrl = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
export const addressUrl = (a: string) => `https://sepolia.basescan.org/address/${a}`;

/** The first sentence: the one-line summary on cards (the full text stays one click away). */
export const firstSentence = (text: string) => {
  const m = text.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
};

/** The five desk agents and the Chief: a colour and initials each (no emoji: they render differently per OS). */
export const AGENT_STYLE: Record<string, { initials: string; color: string; soft: string }> = {
  TRADER_KOL: { initials: "KN", color: "#7c3aed", soft: "#ede9fe" },
  TRADER_WHALE: { initials: "WT", color: "#0369a1", soft: "#e0f2fe" },
  TRADER_NEWS: { initials: "NC", color: "#047857", soft: "#d1fae5" },
  TRADER_MEME: { initials: "MH", color: "#c2410c", soft: "#ffedd5" },
  TRADER_DIP: { initials: "DB", color: "#a16207", soft: "#fef3c7" },
  CHIEF: { initials: "DC", color: "#1f2a44", soft: "#e2e8f0" },
};
