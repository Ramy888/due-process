import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createApp } from "./app.js";
import { emit } from "./bus.js";
import { DeskService } from "./desk-service.js";
import { DeskStore } from "./store.js";
import { localFacilitator } from "./testing/local-facilitator.js";
import { traderAddress } from "./scenario/runner.js";

const ui = { "content-type": "application/json", "x-desk-ui": "1" };

/** A desk whose scenario run is a short script: one co-signed WIF buy by the News Checker. */
function deskWithScriptedRun() {
  const service = new DeskService({
    store: new DeskStore(":memory:"),
    deskUrl: "http://desk",
    paymentsMode: "offline",
    ledgerMode: "local-simulation",
    run: async (deps, _scenario, _beats, runId) => {
      emit({ type: "clearance.started", clearanceId: `0x${"1".repeat(64)}`, trader: traderAddress("TRADER_NEWS"), chain: "solana", token: "WIF", notionalE6: "200000000" });
      const approved = await deps.coSign.request({ beatId: "news-wif", trader: "TRADER_NEWS", symbol: "WIF", notionalUsd: 200, reason: "Two sources agree." });
      if (approved) {
        deps.book!.record("TRADER_NEWS", "WIF", "buy", 200);
        emit({ type: "chief.decision", beatId: "news-wif", trader: "TRADER_NEWS", outcome: "approved", reason: "ok", concerns: [] });
      }
      return { runId: runId!, outcomes: [], book: deps.book!, alerts: [], case: undefined, enforcement: undefined };
    },
  });
  const app = createApp({ deskToken: "t", payTo: "0x0000000000000000000000000000000000000001" as Address, facilitator: localFacilitator(), runClearance: async () => { throw new Error("unused"); }, store: new DeskStore(":memory:"), service });
  return { app, service };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("desk UI API", () => {
  it("refuses human actions that do not come from the desk UI", async () => {
    const { app } = deskWithScriptedRun();
    expect((await app.request("/scenario/run", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await app.request("/approvals/cosign/x", { method: "POST", body: '{"approve":true}' })).status).toBe(403);
  });

  it("runs a scenario in the background, waits for the human's co-sign, then shows the result", async () => {
    const { app } = deskWithScriptedRun();
    const started = await app.request("/scenario/run", { method: "POST", headers: ui, body: "{}" });
    expect(started.status).toBe(202);
    const { runId } = await started.json();
    expect((await app.request("/scenario/run", { method: "POST", headers: ui, body: "{}" })).status).toBe(409);

    await tick();
    let state = await (await app.request("/state")).json();
    expect(state.run).toMatchObject({ runId, status: "running" });
    expect(state.desk).toMatchObject({ paymentsMode: "offline", ledgerMode: "local-simulation", coSignUsd: 150 });
    expect(state.traders).toHaveLength(5);
    const [pending] = state.approvals;
    expect(pending).toMatchObject({ kind: "cosign", request: { trader: "TRADER_NEWS", notionalUsd: 200 } });

    expect((await app.request(`/approvals/cosign/nope`, { method: "POST", headers: ui, body: '{"approve":true}' })).status).toBe(404);
    expect((await app.request(`/approvals/cosign/${pending.id}`, { method: "POST", headers: ui, body: '{"approve":"yes"}' })).status).toBe(400);
    expect((await app.request(`/approvals/cosign/${pending.id}`, { method: "POST", headers: ui, body: '{"approve":true}' })).status).toBe(200);
    await tick();

    state = await (await app.request("/state")).json();
    expect(state.run.status).toBe("finished");
    expect(state.approvals).toEqual([]);
    const news = state.traders.find((t: { key: string }) => t.key === "TRADER_NEWS");
    expect(news).toMatchObject({ holdingsUsd: { WIF: 200 }, spentUsd: 200, approved: 1, clearanceFeesUsd: 0.01, licence: "active", bondUsd: 1 });
    expect(news.pnlUsd).toBeCloseTo(200 * (1.93 / 1.84 - 1), 2);
  });

  it("does not count a fee that was not charged (a check that failed, or a fee that did not settle)", async () => {
    const started = (n: string) =>
      emit({ type: "clearance.started", clearanceId: `0x${n.repeat(64)}`, trader: traderAddress("TRADER_WHALE"), chain: "solana", token: "WIF", notionalE6: "300000000" });
    const service = new DeskService({
      store: new DeskStore(":memory:"),
      deskUrl: "http://desk",
      paymentsMode: "offline",
      ledgerMode: "local-simulation",
      run: async (deps, _scenario, _beats, runId) => {
        started("1");
        emit({ type: "clearance.failed", clearanceId: `0x${"1".repeat(64)}`, error: "the $0.01 fee did not settle (unexpected_settle_error)" });
        started("2");
        return { runId: runId!, outcomes: [], book: deps.book!, alerts: [], case: undefined, enforcement: undefined };
      },
    });
    service.start("frog-day");
    await tick();
    const whale = service.state().traders.find((t) => t.key === "TRADER_WHALE");
    expect(whale?.clearanceFeesUsd).toBeCloseTo(0.01, 6);
  });
});
