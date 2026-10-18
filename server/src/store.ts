// Durable desk state (node:sqlite). Trails live here so a case can be verified and replayed after a restart.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Trail, type TrailEntry } from "./agents/trail.js";
import { emit } from "./bus.js";
import { ROOT } from "./env.js";

export const defaultStorePath = () => process.env.DESK_DB ?? `${ROOT}data/runtime/desk.sqlite`;

export class DeskStore {
  private readonly db: DatabaseSync;

  constructor(path: string = defaultStorePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS trail_entries (
      trail_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (trail_id, seq))`);
  }

  /** Opens (or starts) a trail; each new entry is stored, then announced on the bus. */
  openTrail(id: string): Trail {
    return new Trail(id, this.trailEntries(id), (entry) => {
      this.db
        .prepare("INSERT INTO trail_entries (trail_id, seq, hash, json) VALUES (?, ?, ?, ?)")
        .run(entry.trailId, entry.seq, entry.hash, JSON.stringify(entry));
      emit({ type: "trail.entry", entry });
    });
  }

  trailEntries(id: string): TrailEntry[] {
    return this.db
      .prepare("SELECT json FROM trail_entries WHERE trail_id = ? ORDER BY seq")
      .all(id)
      .map((row) => JSON.parse(String(row.json)) as TrailEntry);
  }

  trailIds(): string[] {
    return this.db
      .prepare("SELECT DISTINCT trail_id FROM trail_entries ORDER BY trail_id")
      .all()
      .map((row) => String(row.trail_id));
  }

  close(): void {
    this.db.close();
  }
}
