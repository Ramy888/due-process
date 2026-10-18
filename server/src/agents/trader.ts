// Trader agents: one role prompt for all five desks, parameterised by the trader's licence. A decision is only a
// proposal: it still has to pass paid clearance, the Desk Chief and the on-chain ledger before anything is recorded.
import { z } from "zod/v4";
import type { AgentRuntime } from "./runtime.js";
import { describeLimits, type MandatePolicy } from "./mandate.js";
import type { FeedItem, ScenarioToken } from "../scenario/scenario.js";
import type { TraderProfile } from "../traders.js";

export const traderDecision = z.object({
  action: z.enum(["trade", "pass"]),
  /** Ticker from the candidates list; empty when passing. */
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  notionalUsd: z.number(),
  /** Two or three plain sentences: why, in words a non-trader understands. */
  reasoning: z.string(),
  /** The feed items or market facts relied on, quoted briefly. */
  evidence: z.array(z.string()),
});
export type TraderDecision = z.infer<typeof traderDecision>;

const SYSTEM = `You are a licensed AI trading agent on the Due Process desk, a supervised desk that makes practice trades
with paper money only. Each turn you get your licence (your mandate in plain words and the exact limits compiled from
it), your budget, what you already hold, the feed you watch, and a market snapshot.

Decide whether to propose one trade from the candidates, or pass. Stay inside your mandate and limits as you
understand them; you are responsible for what you propose. A proposal is not a trade: it must pass a paid pre-trade
clearance check and the Desk Chief's approval, and may be refused.

Answer with action "trade" or "pass". When passing, use symbol "" and notionalUsd 0. Size trades in whole US dollars.
Write reasoning in two or three short sentences of plain English, no jargon, and list the evidence you relied on.`;

export type TraderInput = {
  trader: TraderProfile;
  limits: MandatePolicy;
  allocationUsd: number;
  spentUsd: number;
  holdingsUsd: Record<string, number>;
  feed: FeedItem[];
  market: Record<string, Pick<ScenarioToken, "chain" | "priceUsd" | "liquidityUsd" | "change24hPct">>;
};

export async function decide(runtime: AgentRuntime, input: TraderInput) {
  // Only stable facts go to the model (no ids, addresses or timestamps), so the answer replays.
  const { output, key, source } = await runtime.run({
    role: "trader",
    system: SYSTEM,
    input: {
      you: {
        name: input.trader.name,
        watches: input.trader.watches,
        mandate: input.trader.mandate,
        limits: describeLimits(input.limits, input.allocationUsd),
      },
      budget: { allocationUsd: input.allocationUsd, spentUsd: input.spentUsd },
      holdingsUsd: input.holdingsUsd,
      feed: input.feed,
      market: input.market,
    },
    schema: traderDecision,
    effort: "low",
    validate: (d) => {
      if (d.action === "trade" && !(d.symbol in input.market)) throw new Error(`${input.trader.name} proposed ${d.symbol}, which is not a candidate`);
      if (d.action === "trade" && !(d.notionalUsd > 0)) throw new Error(`${input.trader.name} proposed a non-positive size`);
    },
  });
  return { decision: output, key, source };
}
