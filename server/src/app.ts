// HTTP surface of the desk server. Built from injected dependencies so tests can swap the facilitator and CRE.
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { relative } from "node:path";
import type { Address } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import { ROOT } from "./env.js";
import { getEvidence } from "./evidence.js";
import { clearanceBody, clearancePayload, type ClearanceResult, type RunClearance } from "./clearance.js";
import { clearancePaywall, paymentOf } from "./x402.js";
import { emit } from "./bus.js";

export type AppDeps = { deskToken: string; payTo: Address; facilitator: FacilitatorClient; runClearance: RunClearance };

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

  // Paid per call. Any non-2xx answer below means the facilitator never settles, so the trader is not charged.
  app.use(clearancePaywall({ payTo: deps.payTo, facilitator: deps.facilitator }));
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
      return c.json({ ...result, log });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emit({ type: "clearance.failed", clearanceId, error });
      return c.json({ error: "clearance workflow failed", detail: error }, 502);
    }
  });

  return app;
}
