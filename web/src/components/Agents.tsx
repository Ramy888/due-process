import { useState } from "react";
import { addressUrl, short, usd, type DeskState, type TraderState } from "../desk";
import { Badge, Card, Ext } from "./ui";

function Trader({ t, ledger }: { t: TraderState; ledger: boolean }) {
  const [open, setOpen] = useState(false);
  const left = Math.max(0, t.allocationUsd - t.spentUsd);
  const fees = t.clearanceFeesUsd + t.signalsBoughtUsd;
  return (
    <li className="rounded-lg border border-stone-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{t.name}</div>
          <div className="text-xs text-stone-500">Watches {t.watches}</div>
        </div>
        <Badge tone={t.licence === "active" ? "green" : "red"}>licence {t.licence}</Badge>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-stone-100" title="Budget used">
        <div className="h-full bg-court" style={{ width: `${(t.spentUsd / t.allocationUsd) * 100}%` }} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-stone-500">Budget left</dt>
        <dd className="text-right font-mono">{usd(left)} / {usd(t.allocationUsd)}</dd>
        <dt className="text-stone-500">Bond</dt>
        <dd className="text-right font-mono">{usd(t.bondUsd, 2)} USDC</dd>
        <dt className="text-stone-500">Paper P&amp;L</dt>
        <dd className={`text-right font-mono ${t.pnlUsd > 0 ? "text-emerald-700" : t.pnlUsd < 0 ? "text-rose-700" : ""}`}>{usd(t.pnlUsd, 2)}</dd>
        <dt className="text-stone-500">x402 paid / earned</dt>
        <dd className="text-right font-mono">{usd(fees, 2)} / {usd(t.signalIncomeUsd, 2)}</dd>
        <dt className="text-stone-500">Chief</dt>
        <dd className="text-right">
          {t.approved} approved · {t.autoApproved} auto · {t.refused} refused{t.rejectedByLedger ? ` · ${t.rejectedByLedger} ledger-rejected` : ""}
        </dd>
      </dl>
      {Object.keys(t.holdingsUsd).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(t.holdingsUsd).map(([sym, v]) => (
            <Badge key={sym}>
              {sym} {usd(v)}
            </Badge>
          ))}
        </div>
      )}
      <button onClick={() => setOpen(!open)} className="mt-2 text-xs text-court underline decoration-stone-300 underline-offset-2">
        {open ? "Hide licence" : "Licence terms"}
      </button>
      {open && (
        <div className="mt-1 space-y-1 text-xs text-stone-600">
          <p>{t.mandate}</p>
          <p>
            Wallet {ledger ? <Ext href={addressUrl(t.address)}>{short(t.address)}</Ext> : short(t.address)}
          </p>
        </div>
      )}
    </li>
  );
}

export function Agents({ state }: { state: DeskState }) {
  const ledger = state.desk.ledgerMode === "ledger";
  return (
    <Card title="Licensed agents" aside={`${usd(state.desk.allocationUsd)} each · auto-approve ≤ ${usd(state.desk.autoApproveUsd)} · co-sign > ${usd(state.desk.coSignUsd)}`}>
      <div className="mb-3 rounded-lg bg-stone-50 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">{state.chief.name}</span>
          <Badge tone={state.desk.autoApproveRevoked ? "red" : "blue"}>auto-approve {state.desk.autoApproveRevoked ? "revoked" : "on"}</Badge>
        </div>
        <p className="mt-1 text-stone-600">{state.chief.mandate} Bond {usd(state.chief.bondUsd, 2)} USDC.</p>
      </div>
      <ul className="space-y-3">
        {state.traders.map((t) => (
          <Trader key={t.key} t={t} ledger={ledger} />
        ))}
      </ul>
    </Card>
  );
}
