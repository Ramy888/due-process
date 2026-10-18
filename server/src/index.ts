import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { PORT, required } from "./env.js";
import { getEvidence, putEvidence, evidenceFor } from "./evidence.js";
import { personas } from "./personas.js";

const app = new Hono();
const deskToken = required("DESK_API_TOKEN");

const authorized = (header: string | undefined) => {
  const expected = Buffer.from(`Bearer ${deskToken}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
};

app.get("/health", (c) => c.json({ ok: true }));

app.get("/evidence/:id", (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  const e = getEvidence(c.req.param("id"));
  return e ? c.json(e) : c.json({ error: "not found" }, 404);
});

// Dev seed so the workflow can be simulated before the scenario engine exists.
putEvidence("dev-bonk", evidenceFor(personas.slice(4, 6)));

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (i) => console.log(`desk server on http://127.0.0.1:${i.port}`));
