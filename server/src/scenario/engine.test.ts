import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../agents/canonical.js";
import type { MandatePolicy } from "../agents/mandate.js";
import { ReplayCache } from "../agents/replay.js";
import { AgentRuntime, type ModelFn } from "../agents/runtime.js";
import { verifyTrail } from "../agents/trail.js";
import { subscribe, type DeskEvent } from "../bus.js";
import { DeskBook } from "../desk.js";
import { getEvidence } from "../evidence.js";
import { personaWallet } from "../personas.js";
import { DeskStore } from "../store.js";
import type { TraderKey } from "../traders.js";
import { licenceDesk, runBeat, type ClearanceRequestBody, type EngineDeps } from "./engine.js";
import { loadScenario } from "./scenario.js";

const FROG = "0x438C300F2962604f1281758d9532Ee64f4CE0201";
const FROG_DEPLOYER = "0xb08E236C4A4B1eA8585149fc963DAbB6FAf704fa";
const resolveDeployment = (key: string) => ({ frogToken: FROG, frogDeployer: FROG_DEPLOYER })[key] ?? "";

const policy: MandatePolicy = {
  maxTradeUsd: 300,
  maxPositionPctOfAllocation: 10,
  minLiquidityUsd: 500_000,
  allowedChains: ["solana", "base-sepolia"],
  deniedTokens: [],
  maxTradesPerHour: 4,
  signalEmbargoMinutes: 0,
};
const policies = new Map<TraderKey, MandatePolicy>(
  (["TRADER_KOL", "TRADER_WHALE", "TRADER_NEWS", "TRADER_MEME", "TRADER_DIP"] as const).map((k) => [k, policy]),
);

/** Fake model: the trader answers `reply`; every input it saw is kept. */
function fakeModel(reply: object) {
  const inputs: unknown[] = [];
  const fn: ModelFn = async (task) => (inputs.push(task.input), reply);
  return { fn, inputs };
}
const buyFrog = { action: "trade", symbol: "FROG", side: "buy", notionalUsd: 120, reasoning: "Six voices agree.", evidence: ["6 posts"] };

function deps(model: ModelFn, cleared: Partial<EngineDeps> = {}) {
  const requests: { trader: TraderKey; body: ClearanceRequestBody }[] = [];
  const d: EngineDeps = {
    runtime: new AgentRuntime(model, new ReplayCache(join(mkdtempSync(join(tmpdir(), "eng-")), "c.jsonl")), "cache-first"),
    store: new DeskStore(":memory:"),
    book: new DeskBook(),
    policies,
    runId: "run-1",
    resolveDeployment,
    addressOf: (k) => personaWallet(`@${k}`),
    requestClearance: async (trader, body) => {
      requests.push({ trader, body });
      return {
        clearanceId: `0x${"77".repeat(32)}`,
        verdict: "BLOCKED",
        hits: [{ code: "COORDINATED_SHILL", severity: "block", detail: "4 of 6" }],
        findings: {},
        findingsHash: `0x${"cd".repeat(32)}`,
        mode: "local-simulation",
        txHash: null,
        log: "proof/runs/x.log",
      };
    },
    ...cleared,
  };
  return { d, requests };
}

const events: DeskEvent[] = [];
const off = subscribe((e) => events.push(e));
afterEach(() => void (events.length = 0));

describe("scenario engine", () => {
  const scenario = loadScenario("frog-day");

  it("plays the FROG beat: the KOL trader proposes, pays for clearance with private evidence, and the verdict lands on the trail", async () => {
    const model = fakeModel(buyFrog);
    const seen: unknown[] = [];
    const { d, requests } = deps(model.fn, { afterClearance: async (ctx) => (seen.push(ctx.clearance.verdict), "chief-stage") });
    const out = await runBeat(d, scenario, "frog-convergence");

    expect(requests).toEqual([
      { trader: "TRADER_KOL", body: { chain: "base-sepolia", token: FROG, notionalE6: "120000000", evidenceId: "frog-convergence-frog" } },
    ]);
    const evidence = getEvidence("frog-convergence-frog")!;
    expect(evidence.deployer).toBe(FROG_DEPLOYER);
    expect(evidence.promotingKols.map((k) => k.wallet)).toEqual(
      ["@moonmaxi_sim", "@degen_dana_sim", "@chartwizard_sim", "@alpha_aisha_sim", "@solsensei_sim", "@whalewatch_sim"].map(personaWallet),
    );
    expect(out).toMatchObject({ beatId: "frog-convergence", trader: "TRADER_KOL", steps: [{ clearance: { verdict: "BLOCKED" }, after: "chief-stage" }] });
    expect(seen).toEqual(["BLOCKED"]);

    const trail = d.store.trailEntries("run-1:frog-convergence");
    expect(trail.map((e) => e.kind)).toEqual(["beat.started", "trader.decision", "clearance.verdict"]);
    expect(verifyTrail(trail)).toEqual({ ok: true, head: out.trailHead });
    expect(events.filter((e) => e.type !== "trail.entry").map((e) => e.type)).toEqual(["beat.started", "trader.decision", "beat.finished"]);
  });

  it("gives the model only replay-stable facts: no addresses, ids or deployment details", async () => {
    const model = fakeModel(buyFrog);
    await runBeat(deps(model.fn).d, scenario, "frog-convergence");
    const input = canonicalJson(model.inputs[0]);
    expect(input).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(input).not.toContain("deployment:");
    expect(input).toContain("holder count up every day this week");
    expect(input).toContain("trustedVoices");
  });

  it("records a clearance that could not run and carries on, without asking the Chief", async () => {
    const after: unknown[] = [];
    const { d } = deps(fakeModel(buyFrog).fn, {
      requestClearance: async () => {
        throw new Error("clearance failed (HTTP 502): cre clearance failed (exit 1)");
      },
      afterClearance: async (ctx) => after.push(ctx),
    });
    const out = await runBeat(d, scenario, "frog-convergence");
    expect(out.steps).toEqual([expect.objectContaining({ failed: expect.stringContaining("HTTP 502") })]);
    expect(after).toEqual([]);
    expect(d.store.trailEntries("run-1:frog-convergence").at(-1)).toMatchObject({ kind: "clearance.failed" });
  });

  it("does not pay for clearance when the trader passes", async () => {
    const { d, requests } = deps(fakeModel({ action: "pass", symbol: "", side: "buy", notionalUsd: 0, reasoning: "Too thin.", evidence: [] }).fn);
    const out = await runBeat(d, scenario, "news-wif");
    expect(requests).toEqual([]);
    expect(out.steps).toEqual([{ decision: expect.objectContaining({ action: "pass" }) }]);
  });

  it("refuses a proposal for a token that is not among the beat's candidates", async () => {
    const { d, requests } = deps(fakeModel({ ...buyFrog, symbol: "DOGE" }).fn);
    await expect(runBeat(d, scenario, "frog-convergence")).rejects.toThrow(/not a candidate/);
    expect(requests).toEqual([]);
  });

  it("sells a signal over x402 to each buyer, then plays the staged orders without asking the model", async () => {
    const model = fakeModel(buyFrog);
    const bought: [TraderKey, string][] = [];
    const { d, requests } = deps(model.fn, {
      buySignal: async (buyer, id) => (bought.push([buyer, id]), { text: "tip", settlementTx: `0x${"ee".repeat(32)}` }),
    });
    const scenario = loadScenario("frog-day");
    const out = await runBeat(d, scenario, "meme-signal");

    expect(bought).toEqual([["TRADER_KOL", out.signalId], ["TRADER_DIP", out.signalId]]);
    expect(d.store.signal(out.signalId!)).toMatchObject({ seller: "Meme Hunter", symbol: "POPCAT", sellerAddress: personaWallet("@TRADER_MEME") });
    expect(model.inputs).toEqual([]);
    const orders = scenario.beats.find((b) => b.id === "meme-signal")!.staged!.orders;
    expect(requests.map((r) => r.body.notionalE6)).toEqual(orders.map((o) => String(o.notionalUsd * 1e6)));
    expect(out.steps).toHaveLength(orders.length);
    const kinds = d.store.trailEntries("run-1:meme-signal").map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(["beat.started", "signal.offered", "signal.bought", "signal.bought"]);
    expect(kinds.slice(4)).toEqual(orders.flatMap(() => ["trader.order", "clearance.verdict"]));
  });

  it("licenses all five traders from data/traders.json before any beat", async () => {
    const redTeam = Array.from({ length: 10 }, (_, i) => ({
      description: `edge ${i}`,
      trade: { chain: "solana", token: "X", notionalUsd: 301, positionAfterUsd: 1, liquidityUsd: 1e9, tradesInLastHour: 0, minutesSinceSoldSignal: null },
      breaks: "TRADE_TOO_LARGE",
    }));
    const model: ModelFn = async (task) => (task.role === "mandate-compiler" ? { policy, plainEnglish: "ok", redTeam } : buyFrog);
    const { d } = deps(model);
    const { policies: compiled } = await licenceDesk(d.runtime, d.store, "run-1");
    expect([...compiled.keys()]).toEqual(["TRADER_KOL", "TRADER_WHALE", "TRADER_NEWS", "TRADER_MEME", "TRADER_DIP"]);
    expect(d.store.trailEntries("run-1:licensing")).toHaveLength(5);
  });
});

process.on("exit", off);
