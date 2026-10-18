// Headless scenario run: starts the desk server in-process and plays the beats.
//   npx tsx src/cli/run-scenario.ts --beats news-wif,dip-wif --cosign approve [--offline-payments]
// --offline-payments verifies x402 signatures locally and settles nothing. It exists only for development before the
// trader wallets hold test USDC, prints a banner, and is never available in the server itself.
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../app.js";
import { subscribe } from "../bus.js";
import { runClearanceWithCre } from "../clearance.js";
import { PORT, required } from "../env.js";
import { CoSignQueue } from "../scenario/cosign.js";
import { runScenario } from "../scenario/runner.js";
import { DeskStore } from "../store.js";
import { localFacilitator } from "../testing/local-facilitator.js";
import { facilitatorFromEnv } from "../x402.js";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "frog-day" },
    beats: { type: "string" },
    cosign: { type: "string", default: "decline" },
    "offline-payments": { type: "boolean", default: false },
    deployment: { type: "string" },
  },
});
if (values.cosign !== "approve" && values.cosign !== "decline") throw new Error("--cosign must be approve or decline");

const offline = values["offline-payments"];
if (offline) console.log("\n*** OFFLINE PAYMENTS: x402 signatures are checked locally and NOTHING is settled on-chain. ***\n");

const store = new DeskStore();
const coSign = new CoSignQueue();
const app = createApp({
  deskToken: required("DESK_API_TOKEN"),
  payTo: privateKeyToAccount(required("DESK_PRIVATE_KEY") as Hex).address,
  facilitator: offline ? localFacilitator() : facilitatorFromEnv(),
  runClearance: runClearanceWithCre,
  store,
});
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });

subscribe((e) => {
  switch (e.type) {
    case "beat.started":
      return console.log(`\n== ${e.beatId}: ${e.title}`);
    case "trader.decision":
      return console.log(`   ${e.trader}${e.staged ? " [STAGED]" : ""}: ${e.decision.action} ${e.decision.symbol} $${e.decision.notionalUsd} | ${e.decision.reasoning}`);
    case "signal.sold":
      return console.log(`   signal ${e.signalId} sold to ${e.buyer}`);
    case "clearance.result":
      return console.log(`   clearance ${e.result.verdict} ${JSON.stringify(e.result.hits.map((h) => h.code))} (${e.log})`);
    case "chief.decision":
      return console.log(`   chief: ${e.outcome} | ${e.reason}`);
    case "cosign.requested":
      console.log(`   co-sign requested for $${e.notionalUsd} ${e.symbol}: ${values.cosign}`);
      return void setImmediate(() => coSign.decide(e.id, values.cosign === "approve"));
    case "ledger.write":
      return console.log(`   ledger ${e.kind} (${e.mode}) tx=${e.txHash ?? "none"}`);
  }
});

try {
  const { runId, book } = await runScenario({ store, coSign, deskUrl: `http://127.0.0.1:${PORT}`, deployment: values.deployment }, values.scenario!, values.beats?.split(","));
  console.log(`\nrun ${runId}\nholdings ${JSON.stringify(book.all())}\ntrades recorded ${store.trades().length}, signal sales ${store.sales().length}`);
} finally {
  server.close();
}
