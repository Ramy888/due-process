import { describe, expect, it } from "vitest";
import { retryTransient, type RunClearance } from "./clearance.js";
import { CreRunError, type CreRun } from "./cre.js";

const payload = {} as Parameters<RunClearance>[0];
const ok: CreRun = { runId: "r", result: { verdict: "CLEARED" }, logPath: "x.log" };
// the line the CRE CLI printed when RugCheck was slow during a rehearsal, 2026-10-19
const timeout = new CreRunError(
  'cre clearance failed (exit 1): workflow execution failed: [2]Unknown: [2]Unknown: Get "https://api.rugcheck.xyz/v1/tokens/EKpQ/report/summary": context deadline exceeded',
  "x.log",
);

/** A runner that fails with each error in turn, then succeeds. */
const runner = (...errors: Error[]) => {
  let calls = 0;
  const run: RunClearance = async () => {
    const e = errors[calls++];
    if (e) throw e;
    return ok;
  };
  return { run, calls: () => calls };
};

describe("retryTransient", () => {
  it("runs the clearance once more when an upstream API timed out, and says so in the log", async () => {
    const r = runner(timeout);
    const lines: string[] = [];
    await expect(retryTransient(r.run)(payload, (l) => lines.push(l))).resolves.toBe(ok);
    expect(r.calls()).toBe(2);
    expect(lines.join("\n")).toMatch(/timed out.*once more/);
  });

  it("also runs once more when RugCheck could not build its report (HTTP 400, 2026-10-20)", async () => {
    const busy = new CreRunError(
      "cre clearance failed (exit 1): workflow execution failed: [2]Unknown: GET https://api.rugcheck.xyz/v1/tokens/7GCi/report/summary failed: HTTP 400",
      "x.log",
    );
    const r = runner(busy);
    await expect(retryTransient(r.run)(payload, () => {})).resolves.toBe(ok);
    expect(r.calls()).toBe(2);
  });

  it("never retries an HTTP 400 from any other API (it would mask a bad request)", async () => {
    const bad = new CreRunError("cre clearance failed (exit 1): workflow execution failed: [2]Unknown: GET https://api.dexscreener.com/x failed: HTTP 400", "x.log");
    const r = runner(bad);
    await expect(retryTransient(r.run)(payload, () => {})).rejects.toBe(bad);
    expect(r.calls()).toBe(1);
  });

  it("gives up after the second timeout", async () => {
    const r = runner(timeout, timeout);
    await expect(retryTransient(r.run)(payload, () => {})).rejects.toBe(timeout);
    expect(r.calls()).toBe(2);
  });

  it("never retries any other failure (a rejected write, a bad payload)", async () => {
    const other = new CreRunError("cre clearance failed (exit 1): ✗ write report failed: execution reverted", "x.log");
    const r = runner(other);
    await expect(retryTransient(r.run)(payload, () => {})).rejects.toBe(other);
    expect(r.calls()).toBe(1);
  });
});
