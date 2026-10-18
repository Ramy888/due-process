import type { DeskState } from "../desk";
import { Badge } from "./ui";

export function Header({ state }: { state: DeskState | null }) {
  const d = state?.desk;
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 sm:text-sm">
        <strong>SIMULATED.</strong> AI agents make practice trades with paper money. Influencer posts and news are
        synthetic. Not financial or legal advice.
      </div>
      {d?.paymentsMode === "offline" && (
        <div className="bg-rose-600 px-4 py-1.5 text-center text-xs font-semibold text-white sm:text-sm">
          OFFLINE PAYMENTS: x402 signatures are checked locally and nothing is settled on-chain.
        </div>
      )}
      <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-3 px-4 py-4">
        <div>
          <h1 className="font-serif text-3xl font-bold tracking-tight text-court">Due Process</h1>
          <p className="mt-1 max-w-2xl text-sm text-stone-600">
            Licences, budgets, a Desk Chief and a court for autonomous trading agents. Every trade pays for a Chainlink
            pre-trade check, needs the Chief's signature, and is recorded on a public ledger; abuse goes to an AI court
            and you approve the sanctions.
          </p>
        </div>
        {d && (
          <div className="flex flex-wrap gap-2">
            <Badge tone={d.paymentsMode === "x402" ? "green" : "red"}>
              Payments: {d.paymentsMode === "x402" ? "x402 · Base Sepolia test USDC" : "offline"}
            </Badge>
            <Badge tone={d.ledgerMode === "ledger" ? "green" : "amber"}>
              Ledger: {d.ledgerMode === "ledger" ? "DeskLedger on Base Sepolia" : "local simulation (nothing written)"}
            </Badge>
          </div>
        )}
      </div>
    </header>
  );
}
