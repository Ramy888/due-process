// Requests to the Desk Writer CRE workflow, which writes TRADE / REFUSAL / JUDGMENT reports to DeskLedger.
import type { Address, Hex } from "viem";
import { relative } from "node:path";
import { runCre } from "../cre.js";
import { ROOT } from "../env.js";
import type { LedgerEvent, LedgerReader } from "./chain.js";

export type DeskWriteRequest =
  | {
      kind: "trade";
      trade: { clearanceId: Hex; trader: Address; token: Address; side: 0 | 1; notionalE6: string; nonce: string; trailHash: Hex };
      chiefSig: Hex;
      humanSig: Hex;
    }
  | { kind: "refusal"; refusal: { clearanceId: Hex; trader: Address; trailHash: Hex }; reason: string; chiefSig: Hex }
  | {
      kind: "judgment";
      judgment: { caseId: Hex; defendant: Address; sanctions: number; slashAmountE6: string; caseHash: Hex };
      humanSig: Hex;
    };

export type DeskWriteResult = {
  kind: DeskWriteRequest["kind"];
  mode: "local-simulation" | "ledger";
  txHash: Hex | null;
  log: string;
  /** DeskLedger events in the transaction (ledger mode with a broadcast). */
  events?: LedgerEvent[];
};
export type WriteDesk = (req: DeskWriteRequest) => Promise<DeskWriteResult>;

/** Runs the Desk Writer on the target from the environment, then reads what the contract did with it. */
export const deskWriter =
  (reader?: LedgerReader): WriteDesk =>
  async (req) => {
    const run = await runCre({
      workflow: "desk-writer",
      payload: req,
      target: process.env.CRE_DESK_TARGET ?? "local-simulation",
      broadcast: process.env.CRE_BROADCAST === "1",
    });
    const result = run.result as Omit<DeskWriteResult, "log">;
    if (result?.kind !== req.kind) throw new Error("desk-writer returned an unexpected result");
    const events = result.mode === "ledger" && result.txHash && reader ? await reader.events(result.txHash) : undefined;
    return { ...result, log: relative(ROOT, run.logPath), events };
  };

export const writeDeskWithCre: WriteDesk = deskWriter();

/** Did the ledger accept it? Local simulation writes nothing, so there is nothing to contradict. */
export function ledgerVerdict(
  written: DeskWriteResult,
  success: "TradeRecorded" | "TradeRefused" | "JudgmentRecorded",
): { ok: true } | { ok: false; reason: string } {
  if (written.mode !== "ledger") return { ok: true };
  if (!written.txHash) return { ok: false, reason: "dry run: the report was built but not broadcast" };
  const events = written.events ?? [];
  if (events.some((e) => e.event === success)) return { ok: true };
  const rejected = events.find((e) => typeof e.args.reason === "string");
  return { ok: false, reason: rejected ? String(rejected.args.reason) : "the transaction carried no DeskLedger outcome" };
}
