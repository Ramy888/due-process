// Decisions only the human makes: co-signing a large trade, and approving a court's sanctions before they go
// on-chain. Each request waits here until the human approves or declines it (UI button or CLI flag).
import { randomUUID } from "node:crypto";
import { emit } from "./bus.js";

export type ApprovalKind = "cosign" | "sanctions";

export class ApprovalQueue<T extends object> {
  private readonly pending = new Map<string, { request: T; resolve: (approved: boolean) => void }>();

  constructor(readonly kind: ApprovalKind) {}

  /** Resolves when the human decides. */
  readonly request = (request: T): Promise<boolean> =>
    new Promise((resolve) => {
      const id = randomUUID();
      this.pending.set(id, { request, resolve });
      emit({ type: "approval.requested", kind: this.kind, id, request });
    });

  list(): { id: string; request: T }[] {
    return [...this.pending].map(([id, p]) => ({ id, request: p.request }));
  }

  /** False when there is no such pending request (already decided, or never existed). */
  decide(id: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    emit({ type: "approval.decided", kind: this.kind, id, approved });
    p.resolve(approved);
    return true;
  }
}
