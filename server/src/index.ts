import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { PORT, required } from "./env.js";
import { putEvidence, evidenceFor } from "./evidence.js";
import { personas } from "./personas.js";
import { createApp } from "./app.js";
import { runClearanceWithCre } from "./clearance.js";
import { facilitatorFromEnv } from "./x402.js";

const app = createApp({
  deskToken: required("DESK_API_TOKEN"),
  payTo: privateKeyToAccount(required("DESK_PRIVATE_KEY") as Hex).address,
  facilitator: facilitatorFromEnv(),
  runClearance: runClearanceWithCre,
});

// Dev seed so the workflow can be simulated before the scenario engine exists.
putEvidence("dev-bonk", evidenceFor(personas.slice(4, 6)));

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (i) => console.log(`desk server on http://127.0.0.1:${i.port}`));
