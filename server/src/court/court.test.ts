import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ApprovalQueue } from "../approvals.js";
import { canonicalJson } from "../agents/canonical.js";
import type { MandatePolicy } from "../agents/mandate.js";
import { ReplayCache } from "../agents/replay.js";
import { AgentRuntime, type ModelFn } from "../agents/runtime.js";
import { subscribe } from "../bus.js";
import type { DeskWriteRequest } from "../ledger/desk-writer.js";
import { deskDomain, deskTypes } from "../ledger/eip712.js";
import { DeskStore, type RecordedTrade, type SignalSale } from "../store.js";
import type { TraderKey } from "../traders.js";
import { tryCase, type JudgeAnswer } from "./court.js";
import { enforceSanctions, type SanctionRequest } from "./sanctions.js";
import { surveil } from "./surveillance.js";

const MEME = privateKeyToAccount(generatePrivateKey()).address;
const KOL = privateKeyToAccount(generatePrivateKey()).address;
const CHIEF_ADDR = privateKeyToAccount(generatePrivateKey()).address;
const human = privateKeyToAccount(generatePrivateKey());
const domain = deskDomain(84532, "0xA31F6ec1aBE778FC9D7c202272b40b018554B627");
const names = { TRADER_MEME: "Meme Hunter", TRADER_KOL: "KOL Narrative" };
const at = (min: number) => new Date(Date.parse("2026-10-18T12:00:00Z") + min * 60_000).toISOString();
const policy: MandatePolicy = { maxTradeUsd: 150, maxPositionPctOfAllocation: 5, minLiquidityUsd: 0, allowedChains: ["solana"], deniedTokens: [], maxTradesPerHour: 6, signalEmbargoMinutes: 30 };
const policies = new Map<TraderKey, MandatePolicy>([["TRADER_MEME", policy]]);

function alerts(store: DeskStore) {
  store.putSignal({ id: "sig", runId: "run-1", seller: "Meme Hunter", sellerAddress: MEME, symbol: "POPCAT", text: "tip", priceUsd: 0.05, createdAt: at(0) });
  const sale = (n: number): SignalSale => ({ nonce: `0x${String(n).repeat(64)}` as Hex, signalId: "sig", buyerAddress: KOL, sellerAddress: MEME, at: at(n), settlementTx: `0x${"5".repeat(64)}` as Hex });
  const trade = (n: number): RecordedTrade => ({
    tradeId: `0x${(n + 6).toString(16).repeat(64)}` as Hex, runId: "run-1", beatId: "meme-signal", clearanceId: `0x${"c".repeat(64)}` as Hex, trader: "TRADER_MEME",
    traderAddress: MEME, symbol: "POPCAT", side: "buy", notionalUsd: 90, autoApproved: true, txHash: `0x${"7".repeat(64)}` as Hex, at: at(n + 2),
  });
  return surveil({
    trades: [trade(1), trade(2), trade(3)], sales: [sale(1), sale(2)], signals: new Map([["sig", store.signal("sig")!]]), policies, names,
    traderOf: (a) => (a === MEME ? "TRADER_MEME" : undefined), allocationUsd: 2000, autoApproveUsd: 100,
  });
}

const charges = {
  charges: [
    { defendant: "Meme Hunter", count: "Trading ahead of a signal it sold", allegation: "It sold a tip, then bought first.", citations: ["LICENCE-EMBARGO", "FINRA-5270", "MICA-89"], exhibits: ["E1", "E4", "E6"] },
    { defendant: "Desk Chief", count: "Failure to supervise", allegation: "Its auto-approve rule let split orders through unreviewed.", citations: ["LICENCE-CHIEF", "FINRA-3110", "MICA-92"], exhibits: ["E2", "E11"] },
  ],
};
const ruling: JudgeAnswer = {
  rulings: [
    { defendant: "Meme Hunter", count: "Trading ahead of a signal it sold", guilty: true, reasoning: "E4 precedes E6.", citations: ["LICENCE-EMBARGO"], exhibits: ["E4", "E6"] },
    { defendant: "Desk Chief", count: "Failure to supervise", guilty: true, reasoning: "E2 shows no review.", citations: ["FINRA-3110"], exhibits: ["E2"] },
  ],
  sanctions: [
    { defendant: "Meme Hunter", slashUsd: 1, suspendLicence: true, revokeAutoApprove: false, rationale: "Deliberate." },
    { defendant: "Desk Chief", slashUsd: 0, suspendLicence: false, revokeAutoApprove: true, rationale: "Close the loophole." },
  ],
  summary: "Both defendants are liable.",
};

function court(overrides: Partial<Record<string, unknown>> = {}) {
  const inputs: Record<string, unknown[]> = {};
  const model: ModelFn = async (task) => {
    (inputs[task.role] ??= []).push(task.input);
    if (task.role in overrides) return overrides[task.role];
    switch (task.role) {
      case "surveillance": return { memo: "Front-running in pieces.", defendants: ["Meme Hunter", "Desk Chief"] };
      case "prosecutor": return charges;
      case "defense": {
        const counts = (task.input as { counts: { count: string }[] }).counts;
        return { responses: counts.map((c) => ({ count: c.count, plea: "mitigate", argument: "Small sums." })), mitigation: "First offence." };
      }
      case "judge": return ruling;
    }
  };
  const store = new DeskStore(":memory:");
  const runtime = new AgentRuntime(model, new ReplayCache(join(mkdtempSync(join(tmpdir(), "court-")), "c.jsonl")), "cache-first");
  const market = { POPCAT: { priceUsd: 0.41, closePriceUsd: 0.47 } };
  return { store, inputs, deps: { runtime, store, policies, names, market, buyerName: () => "KOL Narrative" } };
}

describe("AI court", () => {
  it("tries the Meme Hunter and the Desk Chief on deterministic exhibits and records every stage on the case trail", async () => {
    const c = court();
    const result = await tryCase(c.deps, "run-1", alerts(c.store));
    expect(result!.file.defendants).toEqual(["Meme Hunter", "Desk Chief"]);
    expect(result!.file.exhibits.map((e) => e.kind)).toEqual(["alert", "alert", "alert", "signal-sale", "signal-sale", "trade", "trade", "trade", "market", "licence", "desk-rule"]);
    expect(result!.file.exhibits[8].facts).toMatchObject({ movePct: 14.6, paperGains: [{ trader: "Meme Hunter", boughtUsd: 270, paperGainUsd: 39.51 }] });
    expect(c.store.trailEntries("run-1:case").map((e) => e.kind)).toEqual(["case.opened", "case.referral", "case.charges", "case.defense", "case.defense", "case.ruling"]);
    expect(c.inputs.defense).toHaveLength(2);
  });

  it("shows the court agents no ids, nonces, hashes or clock times, so the case replays", async () => {
    const c = court();
    await tryCase(c.deps, "run-1", alerts(c.store));
    const seen = canonicalJson(c.inputs);
    expect(seen).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(seen).not.toMatch(/2026-10-18T/);
    expect(seen).toContain("within 5 minutes");
  });

  it("rejects a charge citing law outside the library", async () => {
    const bad = { charges: [{ ...charges.charges[0], citations: ["UCC-2-207"] }, charges.charges[1]] };
    const c = court({ prosecutor: bad });
    await expect(tryCase(c.deps, "run-1", alerts(c.store))).rejects.toThrow(/outside the library: UCC-2-207/);
  });

  it("rejects evidence that is not an exhibit", async () => {
    const bad = { charges: [{ ...charges.charges[0], exhibits: ["E99"] }, charges.charges[1]] };
    const c = court({ prosecutor: bad });
    await expect(tryCase(c.deps, "run-1", alerts(c.store))).rejects.toThrow(/do not exist: E99/);
  });

  it("rejects sanctions the desk cannot carry out", async () => {
    const revokeTrader = { ...ruling, sanctions: [{ ...ruling.sanctions[0], revokeAutoApprove: true }] };
    const c1 = court({ judge: revokeTrader });
    await expect(tryCase(c1.deps, "run-1", alerts(c1.store))).rejects.toThrow(/only the Desk Chief/);
    const c2 = court({ judge: { ...ruling, sanctions: [{ ...ruling.sanctions[0], slashUsd: 5 }] } });
    await expect(tryCase(c2.deps, "run-1", alerts(c2.store))).rejects.toThrow(/outside 0\.\.1/);
    const c3 = court({ judge: { ...ruling, rulings: [{ ...ruling.rulings[0], guilty: false }, ruling.rulings[1]] } });
    await expect(tryCase(c3.deps, "run-1", alerts(c3.store))).rejects.toThrow(/not found guilty/);
  });
});

describe("sanctions", () => {
  async function decided(approve: boolean) {
    const c = court();
    const { file, trail } = (await tryCase(c.deps, "run-1", alerts(c.store)))!;
    const approvals = new ApprovalQueue<SanctionRequest>("sanctions");
    const off = subscribe((e) => e.type === "approval.requested" && e.kind === "sanctions" && setImmediate(() => approvals.decide(e.id, approve)));
    const writes: DeskWriteRequest[] = [];
    const addresses: Record<string, Address> = { "Meme Hunter": MEME, "Desk Chief": CHIEF_ADDR };
    const result = await enforceSanctions(
      { approvals, human, domain, addressOf: (d) => addresses[d], writeDesk: async (r) => (writes.push(r), { kind: r.kind, mode: "local-simulation", txHash: null, log: "w.log" }) },
      file,
      trail,
    );
    off();
    return { result, writes, trail };
  }

  it("writes nothing when the human declines", async () => {
    const { result, writes } = await decided(false);
    expect(result.approved).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes one human-signed judgment per defendant once approved, committing to the whole case trail", async () => {
    const { result, writes, trail } = await decided(true);
    expect(result.revokedAutoApprove).toBe(true);
    const js = writes as Extract<DeskWriteRequest, { kind: "judgment" }>[];
    expect(js.map((j) => [j.judgment.defendant, j.judgment.sanctions, j.judgment.slashAmountE6])).toEqual([[MEME, 3, "1000000"], [CHIEF_ADDR, 4, "0"]]);
    const approvedAt = trail.entries().find((e) => e.kind === "sanctions.approved")!;
    expect(js.every((j) => j.judgment.caseHash === approvedAt.hash)).toBe(true);
    for (const j of js) {
      const signer = await recoverTypedDataAddress({
        domain, types: deskTypes, primaryType: "Judgment", signature: j.humanSig,
        message: { ...j.judgment, slashAmount: BigInt(j.judgment.slashAmountE6) },
      });
      expect(signer).toBe(human.address);
    }
  });
});
