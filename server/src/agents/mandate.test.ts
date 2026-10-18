import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMandate, compileMandate, RULES, type MandatePolicy, type ProposedTrade, type RuleCode } from "./mandate.js";
import { AgentRuntime, type ModelFn } from "./runtime.js";
import { ReplayCache } from "./replay.js";
import { Trail } from "./trail.js";

const policy: MandatePolicy = {
  maxTradeUsd: 500,
  maxPositionPctOfAllocation: 5,
  minLiquidityUsd: 5_000_000,
  allowedChains: ["solana"],
  deniedTokens: ["DenyMe1111111111111111111111111111111111111"],
  maxTradesPerHour: 3,
  signalEmbargoMinutes: 30,
};
const ALLOCATION = 2000; // 5% => position cap $100

const ok: ProposedTrade = {
  chain: "solana",
  token: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  notionalUsd: 80,
  positionAfterUsd: 90,
  liquidityUsd: 6_000_000,
  tradesInLastHour: 2,
  minutesSinceSoldSignal: null,
};

const breaking: Record<RuleCode, Partial<ProposedTrade>> = {
  CHAIN_NOT_ALLOWED: { chain: "base-sepolia" },
  TOKEN_DENIED: { token: "DenyMe1111111111111111111111111111111111111" },
  TRADE_TOO_LARGE: { notionalUsd: 501, positionAfterUsd: 90 },
  POSITION_TOO_LARGE: { positionAfterUsd: 100.01 },
  LIQUIDITY_TOO_LOW: { liquidityUsd: 4_999_999 },
  TOO_MANY_TRADES: { tradesInLastHour: 3 },
  SIGNAL_EMBARGO: { minutesSinceSoldSignal: 29 },
};

describe("checkMandate", () => {
  it("passes a trade inside every limit", () => {
    expect(checkMandate(policy, ALLOCATION, ok)).toEqual([]);
  });

  it.each(Object.entries(breaking))("catches %s just over the edge", (rule, change) => {
    expect(checkMandate(policy, ALLOCATION, { ...ok, ...change })).toEqual([rule]);
  });

  it("allows trading on a sold signal once the embargo has passed", () => {
    expect(checkMandate(policy, ALLOCATION, { ...ok, minutesSinceSoldSignal: 30 })).toEqual([]);
  });
});

/** A model stand-in that writes the given red team; `slip` makes one red-team trade miss its rule. */
function compilerModel(slip = false): ModelFn {
  const redTeam = Object.entries(breaking).map(([rule, change]) => ({ description: `break ${rule}`, trade: { ...ok, ...change }, breaks: rule }));
  redTeam.push({ description: "second oversized trade", trade: { ...ok, notionalUsd: 600 }, breaks: "TRADE_TOO_LARGE" });
  redTeam.push({ description: "second embargo breach", trade: { ...ok, minutesSinceSoldSignal: slip ? 31 : 5 }, breaks: "SIGNAL_EMBARGO" });
  redTeam.push({ description: "third extra", trade: { ...ok, tradesInLastHour: 7 }, breaks: "TOO_MANY_TRADES" });
  return async () => ({ policy, plainEnglish: "Small trades in deep Solana pools only.", redTeam });
}

const runtime = (model: ModelFn) => new AgentRuntime(model, new ReplayCache(join(mkdtempSync(join(tmpdir(), "mc-")), "c.jsonl")), "cache-first");
const req = { trader: "meme-hunter", mandate: "No tokens under $5M liquidity, max 5% per position.", allocationUsd: ALLOCATION };

describe("Mandate Compiler", () => {
  it("compiles a mandate whose ten red-team trades are all caught, and records it on the trail", async () => {
    const trail = new Trail("licences");
    const compiled = await compileMandate(runtime(compilerModel()), trail, req);
    expect(compiled.redTeam).toHaveLength(10);
    expect(compiled.redTeam.every((r) => r.caught)).toBe(true);
    expect(compiled.defects).toEqual([]);
    expect(new Set(compiled.redTeam.map((r) => r.breaks))).toEqual(new Set(Object.keys(RULES)));
    expect(trail.entries()[0]).toMatchObject({ agent: "mandate-compiler", kind: "mandate.compiled", data: { redTeamCaught: 10, defects: [] } });
  });

  it("reports a red-team trade the limits fail to stop as a defect instead of hiding it", async () => {
    const compiled = await compileMandate(runtime(compilerModel(true)), new Trail("licences"), req);
    expect(compiled.defects).toHaveLength(1);
    expect(compiled.defects[0]).toMatchObject({ breaks: "SIGNAL_EMBARGO", violations: [], caught: false });
  });

  it("refuses an unusable policy", async () => {
    const broken: ModelFn = async () => ({ ...(await compilerModel()({} as never) as object), policy: { ...policy, maxPositionPctOfAllocation: 140 } });
    await expect(compileMandate(runtime(broken), new Trail("licences"), req)).rejects.toThrow(/unusable policy/);
  });
});
