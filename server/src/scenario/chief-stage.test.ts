import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { MandatePolicy } from "../agents/mandate.js";
import { ReplayCache } from "../agents/replay.js";
import { AgentRuntime, type ModelFn } from "../agents/runtime.js";
import { ledgerTokenFor } from "../clearance.js";
import { DeskBook } from "../desk.js";
import type { DeskWriteRequest } from "../ledger/desk-writer.js";
import { deskDomain, deskTypes, reasonHash } from "../ledger/eip712.js";
import { DeskStore } from "../store.js";
import { traders, type TraderKey } from "../traders.js";
import { chiefStage, type ChiefOutcome, type ChiefStageDeps } from "./chief-stage.js";
import type { BeatContext } from "./engine.js";
import { loadScenario } from "./scenario.js";

const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const domain = deskDomain(31337, "0xA31F6ec1aBE778FC9D7c202272b40b018554B627");
const chief = privateKeyToAccount(generatePrivateKey());
const human = privateKeyToAccount(generatePrivateKey());
const newsAddress = privateKeyToAccount(generatePrivateKey()).address;

const policy: MandatePolicy = {
  maxTradeUsd: 1500,
  maxPositionPctOfAllocation: 100,
  minLiquidityUsd: 2_000_000,
  allowedChains: ["solana"],
  deniedTokens: [],
  maxTradesPerHour: 2,
  signalEmbargoMinutes: 30,
};

function setup(review: object | null, opts: Partial<ChiefStageDeps> = {}) {
  const modelCalls: unknown[] = [];
  const model: ModelFn = async (task) => (modelCalls.push(task.input), review);
  const writes: DeskWriteRequest[] = [];
  const store = new DeskStore(":memory:");
  const deps: ChiefStageDeps = {
    runtime: new AgentRuntime(model, new ReplayCache(join(mkdtempSync(join(tmpdir(), "chief-")), "c.jsonl")), "cache-first"),
    book: new DeskBook(),
    policies: new Map<TraderKey, MandatePolicy>([["TRADER_NEWS", policy]]),
    writeDesk: async (req) => (writes.push(req), { kind: req.kind, mode: "local-simulation", txHash: null, log: "proof/runs/w.log" }),
    chief,
    human,
    domain,
    addressOf: () => newsAddress,
    requestCoSign: async () => false,
    autoApproveActive: () => true,
    nonce: () => 7n,
    ...opts,
  };
  const ctx = (notionalUsd: number, verdict: "CLEARED" | "FLAGGED" | "BLOCKED" = "CLEARED"): BeatContext => {
    const scenario = loadScenario("frog-day");
    return {
      scenario,
      beat: scenario.beats.find((b) => b.id === "news-wif")!,
      trader: traders.find((t) => t.key === "TRADER_NEWS")!,
      decision: { action: "trade", symbol: "WIF", side: "buy", notionalUsd, reasoning: "Two sources agree.", evidence: [] },
      token: { symbol: "WIF", chain: "solana", address: WIF },
      clearance: { clearanceId: `0x${"77".repeat(32)}`, verdict, hits: [], findings: {}, findingsHash: `0x${"cd".repeat(32)}`, mode: "local-simulation", txHash: null },
      trail: store.openTrail(`t-${Math.random()}`),
    };
  };
  return { deps, ctx, writes, modelCalls, run: (c: BeatContext) => chiefStage(deps)(c) as Promise<ChiefOutcome> };
}

const approve = { approve: true, reason: "Fits the mandate and the desk is not concentrated in WIF.", concerns: [] };
const refuse = { approve: false, reason: "Two other traders already hold WIF; a third would concentrate the desk.", concerns: ["WIF concentration"] };

const recoverTrade = (req: Extract<DeskWriteRequest, { kind: "trade" }>, signature: `0x${string}`) =>
  recoverTypedDataAddress({
    domain,
    types: deskTypes,
    primaryType: "Trade",
    message: { ...req.trade, notional: BigInt(req.trade.notionalE6), nonce: BigInt(req.trade.nonce) },
    signature,
  });

describe("Desk Chief stage", () => {
  it("does nothing with a blocked trade", async () => {
    const s = setup(approve);
    expect(await s.run(s.ctx(200, "BLOCKED"))).toEqual({ outcome: "blocked" });
    expect(s.modelCalls).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  it("lets a small cleared trade through on the auto-approve rule, without review or signature", async () => {
    const s = setup(approve);
    const c = s.ctx(90);
    const out = await s.run(c);
    expect(out.outcome).toBe("auto-approved");
    expect(s.modelCalls).toEqual([]);
    const [w] = s.writes as Extract<DeskWriteRequest, { kind: "trade" }>[];
    expect(w).toMatchObject({ kind: "trade", chiefSig: "0x", humanSig: "0x", trade: { notionalE6: "90000000", side: 0 } });
    expect(w.trade.trailHash).toBe(c.trail.entries().find((e) => e.kind === "chief.auto-approved")!.hash);
    expect(s.deps.book.holdingsUsd("TRADER_NEWS")).toEqual({ WIF: 90 });
  });

  it("never auto-approves a flagged clearance or while auto-approve is revoked", async () => {
    const flagged = setup(approve);
    await flagged.run(flagged.ctx(90, "FLAGGED"));
    expect(flagged.modelCalls).toHaveLength(1);

    const revoked = setup(approve, { autoApproveActive: () => false });
    await revoked.run(revoked.ctx(90));
    expect(revoked.modelCalls).toHaveLength(1);
  });

  it("signs an approved trade over exactly what the ledger will check, committing to the trail so far", async () => {
    const s = setup(approve);
    const c = s.ctx(200);
    const out = await s.run(c);
    expect(out.outcome).toBe("approved");
    const [w] = s.writes as Extract<DeskWriteRequest, { kind: "trade" }>[];
    expect(w.trade).toMatchObject({ trader: newsAddress, token: ledgerTokenFor("solana", WIF), notionalE6: "200000000", nonce: "7" });
    expect(w.trade.trailHash).toBe(c.trail.entries().find((e) => e.kind === "chief.review")!.hash);
    expect(await recoverTrade(w, w.chiefSig)).toBe(chief.address);
    expect(w.humanSig).toBe("0x");
  });

  it("records a refusal signed by the Chief over the exact reason", async () => {
    const s = setup(refuse);
    const out = await s.run(s.ctx(200));
    expect(out).toMatchObject({ outcome: "refused", reason: refuse.reason });
    const [w] = s.writes as Extract<DeskWriteRequest, { kind: "refusal" }>[];
    expect(w).toMatchObject({ kind: "refusal", reason: refuse.reason, refusal: { trader: newsAddress } });
    const signer = await recoverTypedDataAddress({
      domain,
      types: deskTypes,
      primaryType: "Refusal",
      message: { ...w.refusal, reasonHash: reasonHash(w.reason) },
      signature: w.chiefSig,
    });
    expect(signer).toBe(chief.address);
    expect(s.deps.book.holdingsUsd("TRADER_NEWS")).toEqual({});
  });

  it("tells the Chief which limits a proposal breaks and will not accept an approval of it", async () => {
    const s = setup(approve);
    s.deps.book.record("TRADER_NEWS", "JUP", "buy", 10);
    s.deps.book.record("TRADER_NEWS", "JUP", "buy", 10); // two trades already: the hourly limit is reached
    await expect(s.run(s.ctx(200))).rejects.toThrow(/approved a trade that breaks TOO_MANY_TRADES/);
    expect((s.modelCalls[0] as { brokenLimits: string[] }).brokenLimits).toEqual(["TOO_MANY_TRADES"]);
    expect(s.writes).toEqual([]);
  });

  it("holds a large trade for the human, and writes it only with the human's co-signature", async () => {
    const declined = setup(approve);
    expect(await declined.run(declined.ctx(1200))).toMatchObject({ outcome: "cosign-declined" });
    expect(declined.writes).toEqual([]);

    const asked: unknown[] = [];
    const s = setup(approve, { requestCoSign: async (r) => (asked.push(r), true) });
    expect((await s.run(s.ctx(1200))).outcome).toBe("approved");
    expect(asked).toEqual([expect.objectContaining({ trader: "TRADER_NEWS", symbol: "WIF", notionalUsd: 1200 })]);
    const [w] = s.writes as Extract<DeskWriteRequest, { kind: "trade" }>[];
    expect(await recoverTrade(w, w.humanSig)).toBe(human.address as Address);
  });
});
