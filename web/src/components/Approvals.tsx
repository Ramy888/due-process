import { useState } from "react";
import { deskPost, type Approval } from "../desk";

/** Your answer to one waiting decision, shown where it happens: the co-sign in the desk map, the sanctions in the court. */
export function Decide({ approval, yes, dark = false }: { approval: Approval; yes: string; dark?: boolean }) {
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await deskPost(`/approvals/${approval.kind}/${approval.id}`, { approve });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 gap-2">
      <button
        disabled={busy}
        onClick={() => decide(true)}
        className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-court shadow hover:bg-amber-300 disabled:opacity-50"
      >
        {yes}
      </button>
      <button
        disabled={busy}
        onClick={() => decide(false)}
        className={`rounded-lg border px-4 py-2 text-sm disabled:opacity-50 ${dark ? "border-white/30 text-white hover:bg-white/10" : "border-stone-300 text-stone-700 hover:bg-stone-100"}`}
      >
        Decline
      </button>
    </div>
  );
}
