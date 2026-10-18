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

export type BeatItem =
  | { type: "decision"; trader: string; decision: Decision; staged: boolean }
  | { type: "signal"; buyer: string; symbol: string }
  | { type: "clearance"; clearanceId: string; token: string; notionalE6: string; lines: string[]; verdict?: Verdict; hits?: Hit[]; log?: string; failed?: string }
  | { type: "cosign"; symbol: string; notionalUsd: number; decided?: boolean; approved?: boolean; id: string }
  | { type: "chief"; outcome: string; reason: string; concerns: string[] }
  | { type: "ledger"; kind: string; mode: string; txHash: string | null; recorded: boolean; reason: string | null; log: string };

export type BeatCard = { id: string; title: string; trader: string; items: BeatItem[]; done: boolean; trailId?: string; trailHead?: string };

export type TrailEntry = { trailId: string; seq: number; at: string; agent: string; kind: string; data: any; prevHash: string; hash: string };

export type Courtroom = {
  alerts: { code: string; trader: string; symbol: string; detail: string; unreviewed: boolean }[];
  entries: TrailEntry[];
  decided?: { summary: string; approved: boolean; caseHash: string };
  judgments: { kind: string; txHash: string | null; recorded: boolean; reason: string | null; mode: string }[];
};

export type Floor = { runId: string | null; finished: boolean; error?: string; beats: BeatCard[]; court: Courtroom; licences: TrailEntry[] };

const empty = (): Floor => ({ runId: null, finished: false, beats: [], court: { alerts: [], entries: [], judgments: [] }, licences: [] });

type Ev = { type: string; [k: string]: any };

function updateLast(beats: BeatCard[], f: (b: BeatCard) => BeatCard): BeatCard[] {
  if (beats.length === 0) return beats;
  return [...beats.slice(0, -1), f(beats[beats.length - 1])];
}

function updateClearance(beats: BeatCard[], clearanceId: string, f: (c: Extract<BeatItem, { type: "clearance" }>) => BeatItem): BeatCard[] {
  return beats.map((b) => ({
    ...b,
    items: b.items.map((i) => (i.type === "clearance" && i.clearanceId === clearanceId ? f(i) : i)),
  }));
}

export function reduceFloor(floor: Floor, e: Ev): Floor {
  switch (e.type) {
    case "scenario.started":
      return { ...empty(), runId: e.runId };
    case "scenario.finished":
      return { ...floor, finished: true, error: e.error };
    case "beat.started":
      return { ...floor, beats: [...floor.beats, { id: e.beatId, title: e.title, trader: e.trader, items: [], done: false }] };
    case "beat.finished":
      return { ...floor, beats: floor.beats.map((b) => (b.id === e.beatId ? { ...b, done: true, trailId: e.trailId, trailHead: e.trailHead } : b)) };
    case "trader.decision":
      return { ...floor, beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { type: "decision", trader: e.trader, decision: e.decision, staged: e.staged }] })) };
    case "signal.sold":
      return { ...floor, beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { type: "signal", buyer: e.buyer, symbol: e.symbol }] })) };
    case "clearance.started":
      return {
        ...floor,
        beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { type: "clearance", clearanceId: e.clearanceId, token: e.token, notionalE6: e.notionalE6, lines: [] }] })),
      };
    case "cre.line":
      return { ...floor, beats: updateClearance(floor.beats, e.clearanceId, (c) => ({ ...c, lines: [...c.lines, e.line] })) };
    case "clearance.result":
      return { ...floor, beats: updateClearance(floor.beats, e.result.clearanceId, (c) => ({ ...c, verdict: e.result.verdict, hits: e.result.hits, log: e.log })) };
    case "clearance.failed":
      return { ...floor, beats: updateClearance(floor.beats, e.clearanceId, (c) => ({ ...c, failed: e.error })) };
    case "approval.requested":
      if (e.kind !== "cosign") return floor;
      return {
        ...floor,
        beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { type: "cosign", id: e.id, symbol: e.request.symbol, notionalUsd: e.request.notionalUsd }] })),
      };
    case "approval.decided":
      return {
        ...floor,
        beats: floor.beats.map((b) => ({ ...b, items: b.items.map((i) => (i.type === "cosign" && i.id === e.id ? { ...i, decided: true, approved: e.approved } : i)) })),
      };
    case "chief.decision":
      return { ...floor, beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { type: "chief", outcome: e.outcome, reason: e.reason, concerns: e.concerns }] })) };
    case "ledger.write":
      if (e.beatId === "court") return { ...floor, court: { ...floor.court, judgments: [...floor.court.judgments, e as any] } };
      return { ...floor, beats: updateLast(floor.beats, (b) => ({ ...b, items: [...b.items, { ...(e as any), type: "ledger" }] })) };
    case "surveillance.alerts":
      return { ...floor, court: { ...floor.court, alerts: e.alerts } };
    case "case.decided":
      return { ...floor, court: { ...floor.court, decided: { summary: e.summary, approved: e.approved, caseHash: e.caseHash } } };
    case "trail.entry": {
      const entry = e.entry as TrailEntry;
      if (entry.kind.startsWith("case.") || entry.kind.startsWith("sanctions.")) return { ...floor, court: { ...floor.court, entries: [...floor.court.entries, entry] } };
      if (entry.kind === "mandate.compiled") return { ...floor, licences: [...floor.licences, entry] };
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
