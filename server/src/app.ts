// HTTP surface of the desk server. Built from injected dependencies so tests can swap the facilitator and CRE.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { relative } from "node:path";
import type { Address, Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import { ROOT } from "./env.js";
import { getEvidence } from "./evidence.js";
import { clearanceBody, clearancePayload, type ClearanceResult, type RunClearance } from "./clearance.js";
import { deskPaywall, paymentOf, settleFailureOf } from "./x402.js";
import { emit, recent, subscribe, type DeskEvent } from "./bus.js";
import { verifyTrail } from "./agents/trail.js";
import type { DeskStore } from "./store.js";
import type { DeskService } from "./desk-service.js";

export type AppDeps = {
  deskToken: string;
  payTo: Address;
  facilitator: FacilitatorClient;
  runClearance: RunClearance;
  store: DeskStore;
  /** The UI's desk: scenario runs, live state and the human approvals. */
  service?: DeskService;
};

const VERDICTS = new Set(["CLEARED", "FLAGGED", "BLOCKED"]);

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const expectedAuth = Buffer.from(`Bearer ${deps.deskToken}`);
  const authorized = (header: string | undefined) => {
    const got = Buffer.from(header ?? "");
    return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth);
  };

  app.get("/health", (c) => c.json({ ok: true }));

  // Fetched by the clearance workflow over Confidential HTTP only.
  app.get("/evidence/:id", (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const e = getEvidence(c.req.param("id"));
    return e ? c.json(e) : c.json({ error: "not found" }, 404);
  });

  // Live feed for the UI: recent history first, then every new event.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: DeskEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      for (const e of recent()) await send(e);
      const unsubscribe = subscribe((e) => void send(e));
      stream.onAbort(unsubscribe);
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "{}" }));
      unsubscribe();
    }),
  );

  // Human-only actions. The server listens on 127.0.0.1 only; the custom header also stops other websites in the
  // same browser from triggering them (a cross-origin request with it needs a CORS preflight this server never grants).
  const fromDeskUi = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("x-desk-ui") === "1";

  if (deps.service) {
    const service = deps.service;
    app.get("/state", (c) => c.json(service.state()));
    app.get("/case", (c) => c.json(service.case()));
    app.post("/scenario/run", async (c) => {
      if (!fromDeskUi(c)) return c.json({ error: "desk UI only" }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { scenarioId?: string; beats?: string[] };
      try {
        return c.json(service.start(body.scenarioId ?? "frog-day", body.beats), 202);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
      }
    });
    app.post("/approvals/:kind/:id", async (c) => {
      if (!fromDeskUi(c)) return c.json({ error: "desk UI only" }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { approve?: unknown };
      if (typeof body.approve !== "boolean") return c.json({ error: "approve must be true or false" }, 400);
      const queue = c.req.param("kind") === "cosign" ? service.coSign : c.req.param("kind") === "sanctions" ? service.sanctions : undefined;
      if (!queue || !queue.decide(c.req.param("id"), body.approve)) return c.json({ error: "no such pending approval" }, 404);
      return c.json({ ok: true });
    });
  }

  // A trail and whether its hash chain still holds; the head is the value committed on-chain.
  app.get("/trails/:id", (c) => {
    const entries = deps.store.trailEntries(c.req.param("id"));
    if (entries.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ entries, verification: verifyTrail(entries) });
  });

  // The fee settles after the check has run. When settling fails (the facilitator says no, times out or answers
  // nonsense) the trader gets an error instead of the result; say why on the event stream, or the trade card would
  // wait on the Desk Chief forever.
  const checked = new WeakMap<Request, Hex>();
  app.use("/clearance", async (c, next) => {
    await next();
    const clearanceId = checked.get(c.req.raw);
    if (!clearanceId || c.res.status < 400) return;
    const failed = settleFailureOf(c.res);
    const reason = failed?.errorReason ?? "no reason given";
    const error = !failed
      ? `the payment service did not confirm the $0.01 fee (HTTP ${c.res.status}), so the result was withheld`
      : failed.transaction
        ? `the $0.01 fee did not settle (${reason}; transaction ${failed.transaction} may still land), so the result was withheld`
        : `the $0.01 fee did not settle (${reason}), so nothing was charged and the result was withheld`;
    emit({ type: "clearance.failed", clearanceId, error });
  });

  // Paid per call. Any non-2xx answer below means the facilitator never settles, so the trader is not charged.
  app.use(deskPaywall({ payTo: deps.payTo, facilitator: deps.facilitator, sellerOf: (id) => deps.store.signal(id)?.sellerAddress }));

  // Paid per read, to the trader who wrote the signal. The sale is the evidence surveillance uses later.
  app.get("/signals/:id", (c) => {
    const signal = deps.store.signal(c.req.param("id"));
    if (!signal) return c.json({ error: "not found" }, 404);
    const payment = paymentOf(c.req.header("payment-signature"));
    if (!payment) return c.json({ error: "payment missing" }, 402);
    deps.store.recordSale({ nonce: payment.nonce, signalId: signal.id, buyerAddress: payment.payer, sellerAddress: signal.sellerAddress, at: new Date().toISOString() });
    emit({ type: "signal.sold", signalId: signal.id, symbol: signal.symbol, seller: signal.seller, buyer: payment.payer });
    return c.json({ id: signal.id, symbol: signal.symbol, text: signal.text, seller: signal.seller });
  });

  app.post("/clearance", async (c) => {
    const payment = paymentOf(c.req.header("payment-signature"));
    if (!payment) return c.json({ error: "payment missing" }, 402);
    const parsed = clearanceBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid clearance request", issues: parsed.error.issues }, 400);

    const payload = clearancePayload(parsed.data, payment);
    const { clearanceId, trader, chain, token, notionalE6 } = payload;
    emit({ type: "clearance.started", clearanceId, trader, chain, token, notionalE6 });
    try {
      const run = await deps.runClearance(payload, (line) => emit({ type: "cre.line", clearanceId, line }));
      const result = run.result as ClearanceResult;
      if (result?.clearanceId !== clearanceId || !VERDICTS.has(result.verdict)) {
        throw new Error("workflow returned an unexpected result");
      }
      const log = relative(ROOT, run.logPath);
      emit({ type: "clearance.result", result, log });
      checked.set(c.req.raw, clearanceId);
      return c.json({ ...result, log });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emit({ type: "clearance.failed", clearanceId, error });
      return c.json({ error: "clearance workflow failed", detail: error }, 502);
    }
  });

  return app;
}
