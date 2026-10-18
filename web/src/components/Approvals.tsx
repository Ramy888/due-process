import { useState } from "react";
import { deskPost, usd, type Approval, type DeskState } from "../desk";

/** The human's two decisions: co-sign a large trade, approve a court's sanctions. Sticky while anything waits. */
export function Approvals({ state }: { state: DeskState }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (state.approvals.length === 0) return null;
  const name = (key: string) => state.traders.find((t) => t.key === key)?.name ?? key;
  const decide = async (a: Approval, approve: boolean) => {
    setBusy(a.id);
    await deskPost(`/approvals/${a.kind}/${a.id}`, { approve });
    setBusy(null);
  };
  return (
    <div className="sticky top-0 z-20 border-b border-court/20 bg-court text-white shadow-lg">
      <div className="mx-auto max-w-7xl space-y-3 px-4 py-3">
        {state.approvals.map((a) => (
          <div key={a.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">Your decision</div>
              {a.kind === "cosign" ? (
                <p>
                  The Desk Chief approved a {usd(a.request.notionalUsd)} {a.request.symbol} buy by {name(a.request.trader)}. Trades above{" "}
                  {usd(state.desk.coSignUsd)} also need your co-signature. <span className="text-stone-300">Chief: {a.request.reason}</span>
                </p>
              ) : (
                <div>
                  <p>The court asks you to approve these sanctions before they are recorded on-chain:</p>
                  <ul className="mt-1 list-disc pl-5 text-stone-200">
                    {a.request.sanctions.map((s) => (
                      <li key={s.defendant}>
                        <strong className="text-white">{s.defendant}</strong>:{" "}
                        {[s.slashUsd > 0 && `slash ${usd(s.slashUsd, 2)} of bond`, s.suspendLicence && "suspend licence", s.revokeAutoApprove && "revoke auto-approve for 24 h"]
                          .filter(Boolean)
                          .join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                disabled={busy === a.id}
                onClick={() => decide(a, true)}
                className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-court hover:bg-amber-300 disabled:opacity-50"
              >
                {a.kind === "cosign" ? "Co-sign" : "Approve sanctions"}
              </button>
              <button
                disabled={busy === a.id}
                onClick={() => decide(a, false)}
                className="rounded-lg border border-white/30 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
