import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { createApp } from "./app.js";
import { ledgerTokenFor, type RunClearance } from "./clearance.js";
import { subscribe, type DeskEvent } from "./bus.js";
import { getEvidence } from "./evidence.js";
import { ROOT } from "./env.js";
import { localFacilitator } from "./testing/local-facilitator.js";
import { payingFetch } from "./x402.js";

const DESK: Address = "0x4fAa2A586949D88C7d857a737Ace2C929dEb4f11";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

type Payload = Parameters<RunClearance>[0];

/** Desk server with an offline facilitator and a CRE stand-in that answers like the clearance workflow. */
function desk(cre: (p: Payload, onLine: (l: string) => void) => unknown = (p) => cleared(p)) {
  const facilitator = localFacilitator();
  const calls: Payload[] = [];
  const runClearance: RunClearance = async (payload, onLine) => {
    calls.push(payload);
    return { runId: "r1", result: await cre(payload, onLine), logPath: `${ROOT}proof/runs/fake.log` };
  };
  const app = createApp({ deskToken: "t0ken", payTo: DESK, facilitator, runClearance });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  const trader = generatePrivateKey();
  const pay = (body: unknown) =>
    payingFetch(trader, fetchImpl)("http://desk/clearance", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  return { app, facilitator, calls, pay, traderAddress: privateKeyToAccount(trader).address };
}

const cleared = (p: Payload) => ({
  clearanceId: p.clearanceId,
  verdict: "FLAGGED",
  hits: [{ code: "LP_UNLOCKED", severity: "flag", detail: "16% locked" }],
  findings: { chain: p.chain, token: p.token },
  findingsHash: `0x${"cd".repeat(32)}`,
  mode: "local-simulation",
  txHash: null,
});

const events: DeskEvent[] = [];
const unsubscribe = subscribe((e) => events.push(e));
afterEach(() => void (events.length = 0));

describe("POST /clearance", () => {
  it("runs the workflow for the trader who paid, keyed by the payment nonce, then settles the fee", async () => {
    const d = desk((p, onLine) => (onLine("✓ Workflow compiled"), cleared(p)));
    const res = await d.pay({ chain: "solana", token: BONK, notionalE6: "500000000" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verdict: "FLAGGED", log: "proof/runs/fake.log" });

    const [payload] = d.calls;
    expect(payload).toMatchObject({ trader: d.traderAddress, chain: "solana", token: BONK, notionalE6: "500000000" });
    expect(payload.ledgerToken).toBe(ledgerTokenFor("solana", BONK));
    expect(getEvidence(payload.evidenceId)).toEqual({ promotingKols: [], counterparties: [] });
    expect(d.facilitator.settled).toHaveLength(1);
    expect(payload.clearanceId).toBe(d.facilitator.settled[0].nonce);
    expect(body.clearanceId).toBe(payload.clearanceId);

    expect(events.map((e) => e.type)).toEqual(["clearance.started", "cre.line", "clearance.result"]);
  });

  it("refuses a body that names its own trader, without running the workflow or charging", async () => {
    const d = desk();
    const res = await d.pay({ chain: "solana", token: BONK, notionalE6: "1", trader: DESK });
    expect(res.status).toBe(400);
    expect(d.calls).toEqual([]);
    expect(d.facilitator.settled).toEqual([]);
  });

  it("refuses a token that is not an address on its chain", async () => {
    const d = desk();
    const res = await d.pay({ chain: "base-sepolia", token: BONK, notionalE6: "1" });
    expect(res.status).toBe(400);
    expect(d.calls).toEqual([]);
  });

  it("does not charge when the workflow fails", async () => {
    const d = desk(() => {
      throw new Error("cre clearance failed (exit 1)");
    });
    const res = await d.pay({ chain: "solana", token: BONK, notionalE6: "1" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ detail: "cre clearance failed (exit 1)" });
    expect(d.facilitator.settled).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "clearance.failed" });
  });

  it("does not trust a workflow result for a different clearance", async () => {
    const d = desk((p) => ({ ...cleared(p), clearanceId: `0x${"00".repeat(32)}` }));
    const res = await d.pay({ chain: "solana", token: BONK, notionalE6: "1" });
    expect(res.status).toBe(502);
    expect(d.facilitator.settled).toEqual([]);
  });

  it("keeps the evidence endpoint behind the desk token", async () => {
    const d = desk();
    expect((await d.app.request("/evidence/x")).status).toBe(401);
    expect((await d.app.request("/evidence/x", { headers: { authorization: "Bearer t0ken" } })).status).toBe(404);
  });
});

process.on("exit", unsubscribe);
