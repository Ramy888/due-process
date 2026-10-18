import { relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { PORT, ROOT, required } from "./env.js";
import { putEvidence, evidenceFor } from "./evidence.js";
import { personas } from "./personas.js";
import { createApp } from "./app.js";
import { runClearanceWithCre } from "./clearance.js";
import { DeskService } from "./desk-service.js";
import { DeskStore } from "./store.js";
import { localFacilitator } from "./testing/local-facilitator.js";
import { facilitatorFromEnv } from "./x402.js";

// X402_OFFLINE=1 checks payment signatures locally and settles nothing: for working on the UI before the trader
// wallets hold test USDC. The UI shows a permanent banner whenever it is on.
const offline = process.env.X402_OFFLINE === "1";
const ledgerMode = (process.env.CRE_DESK_TARGET ?? "local-simulation") === "local-simulation" ? "local-simulation" : "ledger";
const store = new DeskStore();
const service = new DeskService({
  store,
  deskUrl: `http://127.0.0.1:${PORT}`,
  deployment: process.env.DEPLOYMENT,
  paymentsMode: offline ? "offline" : "x402",
  ledgerMode,
});

const app = createApp({
  deskToken: required("DESK_API_TOKEN"),
  payTo: privateKeyToAccount(required("DESK_PRIVATE_KEY") as Hex).address,
  facilitator: offline ? localFacilitator() : facilitatorFromEnv(),
  runClearance: runClearanceWithCre,
  store,
  service,
});
// The built UI (web/dist), served from the same origin as the API.
app.use("/*", serveStatic({ root: relative(process.cwd(), `${ROOT}web/dist`) }));

// Dev seed so the workflow can be simulated before the scenario engine exists.
putEvidence("dev-bonk", evidenceFor(personas.slice(4, 6)));

if (offline) console.log("*** OFFLINE PAYMENTS: x402 signatures are checked locally and NOTHING is settled on-chain. ***");
serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (i) => console.log(`desk server on http://127.0.0.1:${i.port} (${ledgerMode})`));
