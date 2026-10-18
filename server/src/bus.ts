// In-process event bus: route handlers and agents publish here; the UI's SSE stream subscribes.
import { EventEmitter } from "node:events";
import type { Address, Hex } from "viem";
import type { ClearanceResult } from "./clearance.js";

export type DeskEvent =
  | { type: "clearance.started"; clearanceId: Hex; trader: Address; chain: string; token: string; notionalE6: string }
  | { type: "cre.line"; clearanceId: Hex; line: string }
  | { type: "clearance.result"; result: ClearanceResult; log: string }
  | { type: "clearance.failed"; clearanceId: Hex; error: string };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (e: DeskEvent) => void bus.emit("event", e);
export function subscribe(fn: (e: DeskEvent) => void): () => void {
  bus.on("event", fn);
  return () => void bus.off("event", fn);
}
