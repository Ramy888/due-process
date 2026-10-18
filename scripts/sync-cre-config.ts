// Writes workflows/*/config.<target>.json (ledger mode) from deployments/<deployment>.json.
//   npx -w server tsx ../scripts/sync-cre-config.ts --deployment base-sepolia
import { parseArgs } from "node:util";
import { relative } from "node:path";
import { ROOT } from "../server/src/env.js";
import { writeCreLedgerConfigs } from "../server/src/ops/cre-config.js";

const { values } = parseArgs({ options: { deployment: { type: "string", default: "base-sepolia" }, target: { type: "string" } } });
for (const c of writeCreLedgerConfigs(values.deployment!, { target: values.target })) {
  console.log(`${relative(ROOT, c.path)}  deskLedger=${c.config.deskLedger}`);
}
