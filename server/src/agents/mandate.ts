// Mandate Compiler: a trader's plain-English licence terms become machine-checkable limits, plus ten red-team
// trades that each should break one limit. A deterministic checker (not the model) then runs every red-team trade
// against the compiled limits; any trade that slips through is reported as a compiler defect.
import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod/v4";
import type { AgentRuntime } from "./runtime.js";
import type { Trail } from "./trail.js";

export const RULES = {
  CHAIN_NOT_ALLOWED: "the token is on a chain the mandate does not allow",
  TOKEN_DENIED: "the token is on the mandate's deny list",
  TRADE_TOO_LARGE: "one trade is larger than the per-trade limit",
  POSITION_TOO_LARGE: "the position after the trade exceeds the allowed share of the trader's allocation",
  LIQUIDITY_TOO_LOW: "the token's pool liquidity is below the mandate's minimum",
  TOO_MANY_TRADES: "the trader already made the maximum number of trades in the last hour",
  SIGNAL_EMBARGO: "the trader sold a signal on this token less recently than the embargo allows",
} as const;
export type RuleCode = keyof typeof RULES;
const ruleCode = z.enum(Object.keys(RULES) as [RuleCode, ...RuleCode[]]);

// Kept free of numeric bounds so it maps cleanly to structured outputs; bounds are checked after parsing.
export const mandatePolicy = z.object({
  maxTradeUsd: z.number(),
  maxPositionPctOfAllocation: z.number(),
  minLiquidityUsd: z.number(),
  allowedChains: z.array(z.enum(["solana", "base-sepolia"])),
  deniedTokens: z.array(z.string()),
  maxTradesPerHour: z.number(),
  signalEmbargoMinutes: z.number(),
});
export type MandatePolicy = z.infer<typeof mandatePolicy>;

export const proposedTrade = z.object({
  chain: z.enum(["solana", "base-sepolia"]),
  token: z.string(),
  notionalUsd: z.number(),
  positionAfterUsd: z.number(),
  liquidityUsd: z.number(),
  tradesInLastHour: z.number(),
  /** Minutes since this trader sold a signal on this token; null if it never did. */
  minutesSinceSoldSignal: z.number().nullable(),
});
export type ProposedTrade = z.infer<typeof proposedTrade>;

const compilerAnswer = z.object({
  policy: mandatePolicy,
  /** One short paragraph a judge can read: what the licence allows, in plain words. */
  plainEnglish: z.string(),
  redTeam: z.array(z.object({ description: z.string(), trade: proposedTrade, breaks: ruleCode })),
});

const SYSTEM = `You are the Mandate Compiler of Due Process, a supervised desk of AI trading agents that make practice trades only.
You turn one trader's licence mandate, written in plain English, into exact numeric limits.

Rules you can set (use every one; pick a permissive value when the mandate is silent and say so in plainEnglish):
${Object.entries(RULES)
  .map(([code, meaning]) => `- ${code}: ${meaning}`)
  .join("\n")}

Field meanings: maxTradeUsd and minLiquidityUsd are US dollars; maxPositionPctOfAllocation is a percentage (0-100) of
allocationUsd; maxTradesPerHour is a whole number; signalEmbargoMinutes is whole minutes (0 means no embargo);
allowedChains lists the chains the trader may trade on ("solana", "base-sepolia"); deniedTokens lists token addresses.

Then red-team your own limits: write exactly 10 trades, each designed to break exactly one rule ("breaks"), covering
every rule at least once, and staying inside every other limit. Make them realistic and close to the edge (just over a
limit, not absurdly over). plainEnglish is at most 3 sentences, no jargon.`;

export type RedTeamResult = { description: string; trade: ProposedTrade; breaks: RuleCode; violations: RuleCode[]; caught: boolean };
export type CompiledMandate = {
  trader: string;
  mandateHash: Hex;
  policy: MandatePolicy;
  plainEnglish: string;
  redTeam: RedTeamResult[];
  /** Red-team trades the compiled limits failed to stop, or that broke a different rule than intended. */
  defects: RedTeamResult[];
  source: "cache" | "model";
};

/** Deterministic: which limits does this trade break? */
export function checkMandate(policy: MandatePolicy, allocationUsd: number, t: ProposedTrade): RuleCode[] {
  const v: RuleCode[] = [];
  if (!policy.allowedChains.includes(t.chain)) v.push("CHAIN_NOT_ALLOWED");
  if (policy.deniedTokens.some((d) => d.toLowerCase() === t.token.toLowerCase())) v.push("TOKEN_DENIED");
  if (t.notionalUsd > policy.maxTradeUsd) v.push("TRADE_TOO_LARGE");
  if (t.positionAfterUsd > (policy.maxPositionPctOfAllocation / 100) * allocationUsd) v.push("POSITION_TOO_LARGE");
  if (t.liquidityUsd < policy.minLiquidityUsd) v.push("LIQUIDITY_TOO_LOW");
  if (t.tradesInLastHour >= policy.maxTradesPerHour) v.push("TOO_MANY_TRADES");
  if (t.minutesSinceSoldSignal !== null && t.minutesSinceSoldSignal < policy.signalEmbargoMinutes) v.push("SIGNAL_EMBARGO");
  return v;
}

function assertSane(p: MandatePolicy) {
  const bad =
    !(p.maxTradeUsd > 0) ||
    !(p.maxPositionPctOfAllocation > 0 && p.maxPositionPctOfAllocation <= 100) ||
    !(p.minLiquidityUsd >= 0) ||
    p.allowedChains.length === 0 ||
    !(Number.isInteger(p.maxTradesPerHour) && p.maxTradesPerHour > 0) ||
    !(Number.isInteger(p.signalEmbargoMinutes) && p.signalEmbargoMinutes >= 0);
  if (bad) throw new Error(`Mandate Compiler produced an unusable policy: ${JSON.stringify(p)}`);
}

export async function compileMandate(
  runtime: AgentRuntime,
  trail: Trail,
  req: { trader: string; mandate: string; allocationUsd: number },
): Promise<CompiledMandate> {
  const { output, key, source } = await runtime.run({
    role: "mandate-compiler",
    system: SYSTEM,
    input: req,
    schema: compilerAnswer,
    effort: "medium",
  });
  assertSane(output.policy);
  if (output.redTeam.length !== 10) throw new Error(`Mandate Compiler wrote ${output.redTeam.length} red-team trades, not 10`);

  const redTeam = output.redTeam.map((r) => {
    const violations = checkMandate(output.policy, req.allocationUsd, r.trade);
    return { ...r, violations, caught: violations.includes(r.breaks) };
  });
  const defects = redTeam.filter((r) => !r.caught || r.violations.length !== 1);
  const compiled: CompiledMandate = {
    trader: req.trader,
    mandateHash: keccak256(stringToBytes(req.mandate)),
    policy: output.policy,
    plainEnglish: output.plainEnglish,
    redTeam,
    defects,
    source,
  };
  trail.append("mandate-compiler", "mandate.compiled", {
    trader: req.trader,
    mandateHash: compiled.mandateHash,
    policy: compiled.policy,
    redTeamCaught: redTeam.filter((r) => r.caught).length,
    defects: defects.map((d) => ({ description: d.description, breaks: d.breaks, violations: d.violations })),
    replayKey: key,
  });
  return compiled;
}
