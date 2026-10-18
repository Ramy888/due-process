// In-process event bus: route handlers and agents publish here; the UI's SSE stream subscribes.
import { EventEmitter } from "node:events";
import type { Address, Hex } from "viem";
import type { ClearanceResult } from "./clearance.js";
import type { TrailEntry } from "./agents/trail.js";
import type { TraderDecision } from "./agents/trader.js";
import type { TraderKey } from "./traders.js";
import type { ChiefOutcome } from "./scenario/chief-stage.js";

export type DeskEvent =
  | { type: "clearance.started"; clearanceId: Hex; trader: Address; chain: string; token: string; notionalE6: string }
  | { type: "cre.line"; clearanceId: Hex; line: string }
  | { type: "clearance.result"; result: ClearanceResult; log: string }
  | { type: "clearance.failed"; clearanceId: Hex; error: string }
  | { type: "trail.entry"; entry: TrailEntry }
  | { type: "beat.started"; beatId: string; title: string; trader: TraderKey }
  | { type: "trader.decision"; beatId: string; trader: TraderKey; decision: TraderDecision; staged: boolean }
  | { type: "beat.finished"; beatId: string; verdict: string | null; trailId: string; trailHead: Hex }
  | { type: "chief.decision"; beatId: string; trader: TraderKey; outcome: ChiefOutcome["outcome"]; reason: string; concerns: string[] }
  | { type: "cosign.requested"; id: string; beatId: string; trader: TraderKey; symbol: string; notionalUsd: number; reason: string }
  | { type: "cosign.decided"; id: string; approved: boolean }
  | { type: "scenario.started"; runId: string; scenarioId: string; beats: string[] }
  | { type: "scenario.finished"; runId: string; error?: string }
  | { type: "ledger.write"; beatId: string; kind: string; mode: string; txHash: Hex | null; log: string }
  | { type: "signal.sold"; signalId: string; symbol: string; seller: string; buyer: Address };

const bus = new EventEmitter();
bus.setMaxListeners(100);

// The last events, so a UI that connects mid-scenario sees what already happened.
const RECENT_LIMIT = 500;
const recentEvents: DeskEvent[] = [];

export function emit(e: DeskEvent): void {
  recentEvents.push(e);
  if (recentEvents.length > RECENT_LIMIT) recentEvents.shift();
  bus.emit("event", e);
}

export function subscribe(fn: (e: DeskEvent) => void): () => void {
  bus.on("event", fn);
  return () => void bus.off("event", fn);
}

export const recent = (): readonly DeskEvent[] => recentEvents;
