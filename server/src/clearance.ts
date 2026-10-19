// Pre-trade clearance requests: the paid HTTP body becomes the CRE clearance workflow's trigger payload.
// The trader is whoever paid (never the body), and the clearance id is the payment's EIP-3009 nonce, so every
// on-chain CLEARANCE can be matched to the USDC transfer that paid for it.
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { putEvidence } from "./evidence.js";
import { runCre, type CreRun, type CreRunOptions } from "./cre.js";
import type { Payment } from "./x402.js";

export const clearanceBody = z
  .object({
    chain: z.enum(["solana", "base-sepolia"]),
    token: z.string(),
    notionalE6: z.string().regex(/^[1-9]\d{0,17}$/),
    /** Set by the scenario engine when it has stored private evidence for this token; otherwise none is known. */
    evidenceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  })
  .strict()
  .refine((b) => (b.chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(b.token), {
    message: "token is not a valid address for its chain",
    path: ["token"],
  });
export type ClearanceBody = z.infer<typeof clearanceBody>;

export type Verdict = "CLEARED" | "FLAGGED" | "BLOCKED";
export type ClearanceResult = {
  clearanceId: Hex;
  verdict: Verdict;
  hits: { code: string; severity: string; detail: string }[];
  findings: Record<string, unknown>;
  findingsHash: Hex;
  mode: "local-simulation" | "ledger";
  txHash: Hex | null;
};

/** The address DeskLedger uses for a token: the ERC-20 itself on EVM, a stable derived id for a Solana mint. */
export const ledgerTokenFor = (chain: ClearanceBody["chain"], token: string): Address =>
  chain === "solana"
    ? getAddress(`0x${keccak256(stringToBytes(`due-process:solana:${token}`)).slice(-40)}`)
    : getAddress(token);

export function clearancePayload(body: ClearanceBody, payment: Payment) {
  let evidenceId = body.evidenceId;
  if (!evidenceId) {
    evidenceId = `none-${payment.nonce.slice(2, 18)}`;
    putEvidence(evidenceId, { promotingKols: [], counterparties: [] });
  }
  return {
    clearanceId: payment.nonce,
    trader: payment.payer,
    chain: body.chain,
    token: body.token,
    ledgerToken: ledgerTokenFor(body.chain, body.token),
    notionalE6: body.notionalE6,
    evidenceId,
  };
}

export type RunClearance = (payload: ReturnType<typeof clearancePayload>, onLine: (line: string) => void) => Promise<CreRun>;

/** A public API (RugCheck, GoPlus, DexScreener) timing out on a read: the workflow stopped before it wrote anything. */
const upstreamTimeout = (e: unknown) => e instanceof Error && /Get "https?:\/\/[^"]+": context deadline exceeded/.test(e.message);

/**
 * One more run when an upstream read timed out. Payment settles only after a 2xx answer, so the trader still pays once;
 * any other failure (a reverted write, a bad payload) is never retried.
 */
export const retryTransient =
  (run: RunClearance): RunClearance =>
  async (payload, onLine) => {
    try {
      return await run(payload, onLine);
    } catch (e) {
      if (!upstreamTimeout(e)) throw e;
      onLine("↻ an upstream API timed out before anything was written; running the clearance once more");
      return run(payload, onLine);
    }
  };

/** Runs the clearance workflow on the target from the environment (local-simulation until DeskLedger is deployed). */
export const runClearanceWithCre: RunClearance = retryTransient((payload, onLine) => {
  const opts: CreRunOptions = {
    workflow: "clearance",
    payload,
    target: process.env.CRE_CLEARANCE_TARGET ?? "local-simulation",
    broadcast: process.env.CRE_BROADCAST === "1",
    onLine,
  };
  return runCre(opts);
});
