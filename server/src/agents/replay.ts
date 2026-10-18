// Replay cache: every model answer is stored under a hash of exactly what was asked (model, role, system prompt,
// output schema, input). The file is committed, so the demo and the video replay identically and offline.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export type ReplayRecord = { key: string; role: string; model: string; input: unknown; output: unknown };

export const replayKey = (parts: { model: string; role: string; system: string; schema: unknown; input: unknown }) =>
  createHash("sha256").update(canonicalJson(parts)).digest("hex");

export class ReplayCache {
  private readonly records = new Map<string, ReplayRecord>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as ReplayRecord;
      this.records.set(r.key, r); // a later line for the same key (a live re-record) wins
    }
  }

  get(key: string): ReplayRecord | undefined {
    return this.records.get(key);
  }

  put(record: ReplayRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${canonicalJson(record)}\n`);
    this.records.set(record.key, record);
  }

  get size(): number {
    return this.records.size;
  }
}
