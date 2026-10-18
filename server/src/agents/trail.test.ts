import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroHash } from "viem";
import { Trail, entryHash, verifyTrail, type TrailEntry } from "./trail.js";
import { DeskStore } from "../store.js";

const clock = () => {
  let t = Date.parse("2026-10-18T12:00:00Z");
  return () => new Date((t += 1000));
};

function sampleTrail() {
  const trail = new Trail("case-frog", [], undefined, clock());
  trail.append("surveillance", "alert", { pattern: "front-running", trader: "meme-hunter" });
  trail.append("prosecutor", "charge", { counts: ["MiCA Art. 91"], evidence: [1, 2] });
  trail.append("judge", "ruling", { guilty: true, slashUsd: 250 });
  return trail;
}

describe("trail", () => {
  it("chains every entry to the one before, from the zero hash", () => {
    const trail = sampleTrail();
    const [a, b, c] = trail.entries();
    expect(a.prevHash).toBe(zeroHash);
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(verifyTrail(trail.entries())).toEqual({ ok: true, head: c.hash });
  });

  it("detects an edited entry, and still detects it when the forger recomputes that entry's hash", () => {
    const entries = structuredClone(sampleTrail().entries()) as TrailEntry[];
    (entries[1].data as { counts: string[] }).counts = ["nothing"];
    expect(verifyTrail(entries)).toEqual({ ok: false, brokenAt: 1 });

    const { hash: _old, ...body } = entries[1];
    entries[1].hash = entryHash(body);
    expect(verifyTrail(entries)).toEqual({ ok: false, brokenAt: 2 });
  });

  it("detects a removed entry", () => {
    const entries = [...sampleTrail().entries()];
    entries.splice(1, 1);
    expect(verifyTrail(entries)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("hashes the same content the same way regardless of key order", () => {
    const a = new Trail("t", [], undefined, clock());
    const b = new Trail("t", [], undefined, clock());
    a.append("x", "k", { one: 1, two: { b: 2, a: 1 } });
    b.append("x", "k", { two: { a: 1, b: 2 }, one: 1 });
    expect(a.head()).toBe(b.head());
  });

  it("refuses to continue a trail that is already broken", () => {
    const entries = structuredClone(sampleTrail().entries()) as TrailEntry[];
    entries[0].agent = "someone-else";
    expect(() => new Trail("case-frog", entries)).toThrow(/broken at entry 0/);
  });

  it("survives a restart through the store and keeps chaining", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-store-"));
    try {
      const path = join(dir, "desk.sqlite");
      const first = new DeskStore(path);
      first.openTrail("case-1").append("judge", "ruling", { guilty: false });
      first.close();

      const second = new DeskStore(path);
      const trail = second.openTrail("case-1");
      trail.append("human", "approved", { by: "appeals judge" });
      expect(trail.entries()).toHaveLength(2);
      expect(verifyTrail(second.trailEntries("case-1"))).toEqual({ ok: true, head: trail.head() });
      expect(second.trailIds()).toEqual(["case-1"]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
