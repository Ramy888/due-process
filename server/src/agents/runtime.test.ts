import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { AgentRuntime, type ModelFn } from "./runtime.js";
import { ReplayCache } from "./replay.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const cacheFile = () => {
  const d = mkdtempSync(join(tmpdir(), "replay-"));
  dirs.push(d);
  return join(d, "cache.jsonl");
};

const answer = z.object({ approve: z.boolean(), reason: z.string() });
const task = (input: unknown) => ({ role: "desk-chief", system: "You approve trades.", input, schema: answer, effort: "low" as const });

function countingModel(reply: unknown = { approve: true, reason: "within budget" }) {
  const calls: unknown[] = [];
  const fn: ModelFn = async (t) => (calls.push(t.input), reply);
  return { fn, calls };
}

describe("agent runtime", () => {
  it("asks the model once, then answers the same question from the cache", async () => {
    const m = countingModel();
    const rt = new AgentRuntime(m.fn, new ReplayCache(cacheFile()), "cache-first");
    const first = await rt.run(task({ trade: 1, desk: { b: 2, a: 1 } }));
    const second = await rt.run(task({ desk: { a: 1, b: 2 }, trade: 1 }));
    expect(first.source).toBe("model");
    expect(second).toEqual({ ...first, source: "cache" });
    expect(m.calls).toHaveLength(1);
  });

  it("asks again when anything in the question changes", async () => {
    const m = countingModel();
    const rt = new AgentRuntime(m.fn, new ReplayCache(cacheFile()), "cache-first");
    await rt.run(task({ trade: 1 }));
    await rt.run(task({ trade: 2 }));
    await rt.run({ ...task({ trade: 1 }), system: "You approve trades. Be strict." });
    expect(m.calls).toHaveLength(3);
  });

  it("replays from the committed file in a new process, and never calls the model in replay mode", async () => {
    const file = cacheFile();
    await new AgentRuntime(countingModel().fn, new ReplayCache(file), "cache-first").run(task({ trade: 1 }));

    const m = countingModel();
    const replay = new AgentRuntime(m.fn, new ReplayCache(file), "replay");
    expect((await replay.run(task({ trade: 1 }))).output).toEqual({ approve: true, reason: "within budget" });
    await expect(replay.run(task({ trade: 99 }))).rejects.toThrow(/replay mode: no recorded answer for desk-chief/);
    expect(m.calls).toEqual([]);
  });

  it("live mode re-asks and the newest answer wins on the next load", async () => {
    const file = cacheFile();
    await new AgentRuntime(countingModel().fn, new ReplayCache(file), "cache-first").run(task({ trade: 1 }));
    const refuse = countingModel({ approve: false, reason: "too much in one basket" });
    await new AgentRuntime(refuse.fn, new ReplayCache(file), "live").run(task({ trade: 1 }));
    expect(refuse.calls).toHaveLength(1);
    const again = await new AgentRuntime(countingModel().fn, new ReplayCache(file), "replay").run(task({ trade: 1 }));
    expect(again.output.approve).toBe(false);
  });

  it("rejects a model answer that does not match the role's schema, and does not cache it", async () => {
    const file = cacheFile();
    const rt = new AgentRuntime(countingModel({ approve: "yes" }).fn, new ReplayCache(file), "cache-first");
    await expect(rt.run(task({ trade: 1 }))).rejects.toThrow();
    expect(new ReplayCache(file).size).toBe(0);
  });

  it("rejects a tampered cache entry instead of trusting it", async () => {
    const file = cacheFile();
    await new AgentRuntime(countingModel().fn, new ReplayCache(file), "cache-first").run(task({ trade: 1 }));
    writeFileSync(file, readFileSync(file, "utf8").replace('"approve":true', '"approve":"of course"'));
    await expect(new AgentRuntime(countingModel().fn, new ReplayCache(file), "replay").run(task({ trade: 1 }))).rejects.toThrow();
  });

  it("asks once more when an answer fails the role's checks, and never caches the failed one", async () => {
    const file = cacheFile();
    const replies = [{ approve: true, reason: "" }, { approve: true, reason: "within budget" }];
    const model: ModelFn = async () => replies.shift();
    const rt = new AgentRuntime(model, new ReplayCache(file), "cache-first");
    const strict = { ...task({ trade: 1 }), validate: (o: { reason: string }) => { if (!o.reason) throw new Error("no reason given"); } };
    expect((await rt.run(strict)).output.reason).toBe("within budget");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("gives up after the retry fails too", async () => {
    const rt = new AgentRuntime(countingModel({ approve: true, reason: "" }).fn, new ReplayCache(cacheFile()), "cache-first");
    await expect(rt.run({ ...task({ trade: 1 }), validate: () => { throw new Error("no reason given"); } })).rejects.toThrow("no reason given");
  });
});
