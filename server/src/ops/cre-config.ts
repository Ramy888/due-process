// Generates each workflow's ledger-mode config (config.<target>.json) from its local-simulation config and a
// deployment file, so a deploy is followed by exactly one command before CRE can write to the new DeskLedger.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.js";

export const WORKFLOWS = ["clearance", "desk-writer"] as const;

export function creLedgerConfigs(deployment: string, opts: { target?: string; workflowsDir?: string; deploymentsDir?: string } = {}) {
  const target = opts.target ?? deployment;
  const workflowsDir = opts.workflowsDir ?? join(ROOT, "workflows");
  const dep = JSON.parse(readFileSync(join(opts.deploymentsDir ?? join(ROOT, "deployments"), `${deployment}.json`), "utf8"));
  if (!/^0x[0-9a-fA-F]{40}$/.test(dep.deskLedger ?? "")) throw new Error(`deployments/${deployment}.json has no deskLedger address`);
  return WORKFLOWS.map((wf) => {
    const local = JSON.parse(readFileSync(join(workflowsDir, wf, "config.local-simulation.json"), "utf8"));
    const config = { ...local, mode: "ledger", deskLedger: dep.deskLedger };
    const path = join(workflowsDir, wf, `config.${target}.json`);
    return { workflow: wf, path, config };
  });
}

export function writeCreLedgerConfigs(deployment: string, opts: Parameters<typeof creLedgerConfigs>[1] = {}) {
  const configs = creLedgerConfigs(deployment, opts);
  for (const c of configs) writeFileSync(c.path, `${JSON.stringify(c.config, null, 2)}\n`);
  return configs;
}
