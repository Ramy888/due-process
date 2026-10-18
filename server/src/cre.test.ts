import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.js";
import { CreRunError, failureLine, parseSimulationResult, runCre, type CreRunnerConfig } from "./cre.js";

// A real `cre workflow simulate clearance` log (BONK, local-simulation), recorded 2026-10-18.
const BONK_LOG = `${ROOT}proof/t9-clearance-bonk-local.log`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A stand-in `cre` binary: records its arguments and payload, then runs `body`. */
function fakeCre(body: string): CreRunnerConfig {
  const dir = mkdtempSync(join(tmpdir(), "cre-test-"));
  dirs.push(dir);
  const bin = join(dir, "cre");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" > "${dir}/args"\nfor a in "$@"; do case "$a" in payloads/*) cp "$a" "${dir}/payload-seen";; esac; done\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, workflowsDir: join(dir, "workflows"), logsDir: join(dir, "logs"), timeoutMs: 10_000 };
}
const dirOf = (c: CreRunnerConfig) => c.workflowsDir.replace(/\/workflows$/, "");

describe("parseSimulationResult", () => {
  it("decodes the workflow's JSON-string return value from a real simulate log", () => {
    const result = parseSimulationResult(readFileSync(BONK_LOG, "utf8")) as Record<string, unknown>;
    expect(result).toMatchObject({ verdict: "FLAGGED", mode: "local-simulation", txHash: null });
    expect(result.clearanceId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns undefined when the run produced no result", () => {
    expect(parseSimulationResult("Initializing...\nError: workflow panicked\n")).toBeUndefined();
  });
});

describe("failureLine", () => {
  it("picks the line that says why the simulation failed", () => {
    const log = "✓ Workflow compiled\n[SIMULATION] Received interrupt signal\n✗ workflow execution failed: Cannot decode zero data (\"0x\")\n\nVersion: viem@2.57.7\n";
    expect(failureLine(log)).toBe('workflow execution failed: Cannot decode zero data ("0x")');
    expect(failureLine("Error: RPC unreachable\n")).toBe("Error: RPC unreachable");
    expect(failureLine("just output\n")).toBe("just output");
  });
});

describe("runCre", () => {
  const opts = { workflow: "clearance" as const, payload: { hello: "cre" }, target: "local-simulation", broadcast: false };

  it("runs the simulator in the CRE project, streams lines, keeps the log and cleans up the payload", async () => {
    const config = fakeCre(`cat "${BONK_LOG}"`);
    const lines: string[] = [];
    const run = await runCre({ ...opts, onLine: (l) => lines.push(l) }, config);

    expect((run.result as { verdict: string }).verdict).toBe("FLAGGED");
    const args = readFileSync(join(dirOf(config), "args"), "utf8").trim();
    expect(args).toMatch(/^workflow simulate clearance --target local-simulation --non-interactive --trigger-index 0 --http-payload payloads\/runtime\/[0-9a-f-]+\.json$/);
    expect(JSON.parse(readFileSync(join(dirOf(config), "payload-seen"), "utf8"))).toEqual({ hello: "cre" });
    expect(lines).toContain("✓ Workflow compiled");
    expect(readFileSync(run.logPath, "utf8")).toBe(readFileSync(BONK_LOG, "utf8"));
    expect(readdirSync(join(config.workflowsDir, "payloads/runtime"))).toEqual([]);
  });

  it("adds --broadcast only when asked", async () => {
    const config = fakeCre(`cat "${BONK_LOG}"`);
    await runCre({ ...opts, broadcast: true }, config);
    expect(readFileSync(join(dirOf(config), "args"), "utf8").trim()).toMatch(/ --broadcast$/);
  });

  it("fails with the log tail when the simulator exits non-zero, and still removes the payload", async () => {
    const config = fakeCre(`echo "Error: RPC unreachable"; exit 3`);
    const err = await runCre(opts, config).catch((e) => e);
    expect(err).toBeInstanceOf(CreRunError);
    expect(err.message).toContain("exit 3");
    expect(err.message).toContain("RPC unreachable");
    expect(existsSync(err.logPath)).toBe(true);
    expect(readdirSync(join(config.workflowsDir, "payloads/runtime"))).toEqual([]);
  });

  it("keeps the desk's wallet keys and the Anthropic key out of the simulator's environment", async () => {
    process.env.ANTHROPIC_API_KEY ??= "sk-test-not-real";
    expect(process.env.DESK_PRIVATE_KEY).toBeTruthy(); // loaded from the root .env, as in the server
    const config = fakeCre(`env > "${"$"}(dirname "$0")/env-seen"; cat "${BONK_LOG}"`);
    await runCre(opts, config);
    const seen = readFileSync(join(dirOf(config), "env-seen"), "utf8");
    expect(seen).toMatch(/^PATH=/m);
    expect(seen).not.toMatch(/PRIVATE_KEY|ANTHROPIC|DESK_API_TOKEN/);
  });

  it("never runs two simulations at once", async () => {
    const config = fakeCre(`E="${"$"}(dirname "$0")/events"; echo start >> "$E"; sleep 0.2; echo end >> "$E"; cat "${BONK_LOG}"`);
    await Promise.all([runCre(opts, config), runCre(opts, config), runCre(opts, config)]);
    expect(readFileSync(join(dirOf(config), "events"), "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end", "start", "end"]);
  });
});
