import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../env.js";
import { writeCreLedgerConfigs } from "./cre-config.js";

describe("CRE ledger configs", () => {
  it("copies each workflow's local config, switching to ledger mode against the deployed DeskLedger", () => {
    const dir = mkdtempSync(join(tmpdir(), "crecfg-"));
    for (const wf of ["clearance", "desk-writer"]) {
      mkdirSync(join(dir, "workflows", wf), { recursive: true });
      cpSync(join(ROOT, "workflows", wf, "config.local-simulation.json"), join(dir, "workflows", wf, "config.local-simulation.json"));
    }
    mkdirSync(join(dir, "deployments"));
    writeFileSync(join(dir, "deployments", "base-sepolia.json"), JSON.stringify({ deskLedger: "0x00000000000000000000000000000000000000d1", chainId: 84532 }));

    const written = writeCreLedgerConfigs("base-sepolia", { workflowsDir: join(dir, "workflows"), deploymentsDir: join(dir, "deployments") });
    for (const { workflow, path } of written) {
      const local = JSON.parse(readFileSync(join(ROOT, "workflows", workflow, "config.local-simulation.json"), "utf8"));
      expect(path.endsWith(`${workflow}/config.base-sepolia.json`)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...local, mode: "ledger", deskLedger: "0x00000000000000000000000000000000000000d1" });
    }
  });

  it("refuses a deployment file without a ledger address", () => {
    const dir = mkdtempSync(join(tmpdir(), "crecfg-"));
    mkdirSync(join(dir, "deployments"));
    writeFileSync(join(dir, "deployments", "x.json"), "{}");
    expect(() => writeCreLedgerConfigs("x", { deploymentsDir: join(dir, "deployments") })).toThrow(/no deskLedger/);
  });
});
