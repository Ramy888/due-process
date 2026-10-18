// Trades above the co-sign threshold wait here until the human approves or declines them (UI button or CLI flag).
import { randomUUID } from "node:crypto";
import { emit } from "../bus.js";
import type { CoSignRequest } from "./chief-stage.js";

export class CoSignQueue {
  private readonly pending = new Map<string, { req: CoSignRequest; resolve: (approved: boolean) => void }>();

  /** Called by the Chief stage; resolves when the human decides. */
  readonly request = (req: CoSignRequest): Promise<boolean> =>
    new Promise((resolve) => {
      const id = randomUUID();
      this.pending.set(id, { req, resolve });
      emit({ type: "cosign.requested", id, ...req });
    });

  list(): { id: string; req: CoSignRequest }[] {
    return [...this.pending].map(([id, p]) => ({ id, req: p.req }));
  }

  /** False when there is no such pending request (already decided, or never existed). */
  decide(id: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    emit({ type: "cosign.decided", id, approved });
    p.resolve(approved);
    return true;
  }
}
