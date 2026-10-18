// The JSON trail: every agent step is appended as an entry that hashes its predecessor, so the head hash commits
// to the whole history. That head is the trailHash written on-chain with a TRADE and the caseHash of a JUDGMENT;
// anyone holding the entries can recompute it.
import { keccak256, stringToBytes, zeroHash, type Hex } from "viem";
import { canonicalJson } from "./canonical.js";

export type TrailEntry = {
  trailId: string;
  seq: number;
  at: string;
  agent: string;
  kind: string;
  data: unknown;
  prevHash: Hex;
  hash: Hex;
};

export const entryHash = (e: Omit<TrailEntry, "hash">): Hex => keccak256(stringToBytes(canonicalJson(e)));

export class Trail {
  private readonly items: TrailEntry[];

  constructor(
    readonly id: string,
    existing: TrailEntry[] = [],
    private readonly persist?: (e: TrailEntry) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    const check = verifyTrail(existing);
    if (!check.ok) throw new Error(`trail ${id} is broken at entry ${check.brokenAt}`);
    this.items = [...existing];
  }

  append(agent: string, kind: string, data: unknown): TrailEntry {
    const body = {
      trailId: this.id,
      seq: this.items.length,
      at: this.now().toISOString(),
      agent,
      kind,
      // round-trip so the stored entry is exactly what was hashed (no undefined, no class instances)
      data: JSON.parse(canonicalJson(data ?? null)),
      prevHash: this.head(),
    };
    const entry = { ...body, hash: entryHash(body) };
    this.items.push(entry);
    this.persist?.(entry);
    return entry;
  }

  head(): Hex {
    return this.items.at(-1)?.hash ?? zeroHash;
  }

  entries(): readonly TrailEntry[] {
    return this.items;
  }
}

/** Recomputes every hash and link. `brokenAt` is the first entry that does not match. */
export function verifyTrail(entries: readonly TrailEntry[]): { ok: true; head: Hex } | { ok: false; brokenAt: number } {
  let prev: Hex = zeroHash;
  for (const [i, { hash, ...body }] of entries.entries()) {
    if (body.seq !== i || body.prevHash !== prev || entryHash(body) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, head: prev };
}
