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
import { ApprovalQueue } from "../approvals.js";
import type { CoSignRequest } from "../scenario/chief-stage.js";
import type { SanctionRequest } from "../court/sanctions.js";
import { runScenario } from "../scenario/runner.js";
import { DeskStore } from "../store.js";
import { localFacilitator } from "../testing/local-facilitator.js";
import { facilitatorFromEnv } from "../x402.js";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "frog-day" },
    beats: { type: "string" },
    cosign: { type: "string", default: "decline" },
    sanctions: { type: "string", default: "decline" },
    "offline-payments": { type: "boolean", default: false },
    deployment: { type: "string" },
  },
});
for (const flag of ["cosign", "sanctions"] as const)
  if (values[flag] !== "approve" && values[flag] !== "decline") throw new Error(`--${flag} must be approve or decline`);

const offline = values["offline-payments"];
if (offline) console.log("\n*** OFFLINE PAYMENTS: x402 signatures are checked locally and NOTHING is settled on-chain. ***\n");

const store = new DeskStore();
const coSign = new ApprovalQueue<CoSignRequest>("cosign");
const sanctions = new ApprovalQueue<SanctionRequest>("sanctions");
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
    case "clearance.failed":
      return console.log(`   clearance could not run: ${e.error.split("\n")[0]}`);
    case "clearance.result":
      return console.log(`   clearance ${e.result.verdict} ${JSON.stringify(e.result.hits.map((h) => h.code))} (${e.log})`);
    case "chief.decision":
      return console.log(`   chief: ${e.outcome} | ${e.reason}`);
    case "approval.requested": {
      if (e.kind === "cosign") {
        const r = e.request as CoSignRequest;
        console.log(`   co-sign requested for $${r.notionalUsd} ${r.symbol}: ${values.cosign}`);
        return void setImmediate(() => coSign.decide(e.id, values.cosign === "approve"));
      }
      const r = e.request as SanctionRequest;
      console.log(`\n== sanctions for approval: ${values.sanctions}\n${r.sanctions.map((x) => `   ${x.defendant}: slash $${x.slashUsd}${x.suspendLicence ? ", suspend licence" : ""}${x.revokeAutoApprove ? ", revoke auto-approve" : ""} | ${x.rationale}`).join("\n")}`);
      return void setImmediate(() => sanctions.decide(e.id, values.sanctions === "approve"));
    }
    case "surveillance.alerts":
      return console.log(`\n== surveillance: ${e.alerts.length} alert(s)\n${e.alerts.map((a) => `   ${a.code}: ${a.detail}`).join("\n")}`);
    case "trail.entry": {
      const d = e.entry.data as Record<string, any>;
      if (e.entry.kind === "case.charges") return console.log(`\n== charges\n${d.charges.map((c: any) => `   ${c.defendant} | ${c.count} [${c.citations.join(", ")}] ${c.exhibits.join(",")}`).join("\n")}`);
      if (e.entry.kind === "case.defense") return console.log(`   defense for ${d.defendant}: ${d.responses.map((r: any) => r.plea).join(", ")} | ${d.mitigation}`);
      if (e.entry.kind === "case.ruling") return console.log(`\n== ruling\n${d.rulings.map((r: any) => `   ${r.defendant} | ${r.count}: ${r.guilty ? "GUILTY" : "not guilty"} | ${r.reasoning}`).join("\n")}\n   ${d.summary}`);
      return;
    }
    case "case.decided":
      return console.log(`\n== case decided (sanctions ${e.approved ? "approved" : "declined"}) caseHash ${e.caseHash}`);
    case "ledger.write":
      return console.log(`   ledger ${e.kind} (${e.mode}) tx=${e.txHash ?? "none"}`);
  }
});

let exitCode = 0;
try {
  const { runId, book } = await runScenario({ store, coSign, sanctions, deskUrl: `http://127.0.0.1:${PORT}`, deployment: values.deployment }, values.scenario!, values.beats?.split(","));
  console.log(`\nrun ${runId}\nholdings ${JSON.stringify(book.all())}\ntrades recorded ${store.trades(runId).length}, signal sales ${store.sales(runId).length}`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  // keep-alive sockets from the traders' own HTTP calls would otherwise hold the process open
  server.close();
  process.exit(exitCode);
}
