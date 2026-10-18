// Requests to the Desk Writer CRE workflow, which writes TRADE / REFUSAL / JUDGMENT reports to DeskLedger.
import type { Address, Hex } from "viem";
import { relative } from "node:path";
import { runCre } from "../cre.js";
import { ROOT } from "../env.js";

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

export type DeskWriteResult = { kind: DeskWriteRequest["kind"]; mode: "local-simulation" | "ledger"; txHash: Hex | null; log: string };
export type WriteDesk = (req: DeskWriteRequest) => Promise<DeskWriteResult>;

/** Runs the Desk Writer on the target from the environment (local-simulation until DeskLedger is deployed). */
export const writeDeskWithCre: WriteDesk = async (req) => {
  const run = await runCre({
    workflow: "desk-writer",
    payload: req,
    target: process.env.CRE_DESK_TARGET ?? "local-simulation",
    broadcast: process.env.CRE_BROADCAST === "1",
  });
  const result = run.result as Omit<DeskWriteResult, "log">;
  if (result?.kind !== req.kind) throw new Error("desk-writer returned an unexpected result");
  return { ...result, log: relative(ROOT, run.logPath) };
};
