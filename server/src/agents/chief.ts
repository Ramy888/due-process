// The Desk Chief: the four-eyes supervisor. It sees every trader's book at once, so it can refuse what no single
// trader would notice (three robots in one coin). Its approval is an EIP-712 signature the ledger verifies.
import { z } from "zod/v4";
import type { AgentRuntime } from "./runtime.js";
import { describeLimits, type MandatePolicy, type RuleCode } from "./mandate.js";
import type { TraderDecision } from "./trader.js";

export const chiefReview = z.object({
  approve: z.boolean(),
  /** One or two plain sentences, stored on-chain with a refusal. */
  reason: z.string(),
  /** Desk-level concerns the Chief noticed, even when approving. */
  concerns: z.array(z.string()),
});
export type ChiefReview = z.infer<typeof chiefReview>;

const SYSTEM = `You are the Desk Chief of Due Process, a supervised desk of AI trading agents making practice trades with
paper money. You are legally responsible for supervising every trader (the "failure to supervise" duty).

Every trade proposal reaches you after it passed a paid pre-trade clearance check. You see the proposal, the trader's
licence limits, any limits the proposal breaks (computed exactly by the desk), the clearance findings, and every
trader's current holdings.

Approve or refuse. You must refuse if any licence limit is broken. Also refuse when the desk as a whole would take on
too much risk, for example when other traders already hold the same coin and the desk would become concentrated in it
(desk policy: no more than two traders in the same coin). A clearance verdict of FLAGGED means a risk was found but not
a blocking one; weigh it.

Write the reason in one or two plain sentences that a judge with no trading background understands; it is stored
on-chain with a refusal. List any desk-level concerns, even when approving.`;

export type ChiefInput = {
  trader: { name: string; mandate: string; limits: MandatePolicy; allocationUsd: number; spentUsd: number };
  proposal: Pick<TraderDecision, "symbol" | "side" | "notionalUsd" | "reasoning">;
  brokenLimits: RuleCode[];
  clearance: { verdict: string; findings: string[] };
  /** Desk-wide view: trader name -> coin -> USD held. */
  deskHoldings: Record<string, Record<string, number>>;
};

export async function reviewTrade(runtime: AgentRuntime, input: ChiefInput) {
  return runtime.run({
    role: "desk-chief",
    system: SYSTEM,
    input: {
      trader: {
        name: input.trader.name,
        mandate: input.trader.mandate,
        limits: describeLimits(input.trader.limits, input.trader.allocationUsd),
        budget: { allocationUsd: input.trader.allocationUsd, spentUsd: input.trader.spentUsd },
      },
      proposal: input.proposal,
      brokenLimits: input.brokenLimits,
      clearance: input.clearance,
      deskHoldings: input.deskHoldings,
    },
    schema: chiefReview,
    effort: "medium",
    validate: (r) => {
      if (r.approve && input.brokenLimits.length > 0) {
        throw new Error(`Desk Chief approved a trade that breaks ${input.brokenLimits.join(", ")}`);
      }
      if (!r.reason.trim()) throw new Error("Desk Chief gave no reason");
    },
  });
}
