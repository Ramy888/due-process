// Runs a whole scenario with the real desk wiring: licences, beats, paid clearance and signals over HTTP to the desk
// server, the Desk Chief stage, the Desk Writer workflow, and the human co-sign queue.
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runtimeFromEnv, type AgentRuntime } from "../agents/runtime.js";
import { emit } from "../bus.js";
import { DESK, DeskBook } from "../desk.js";
import { ROOT, required } from "../env.js";
import { deskDomain } from "../ledger/eip712.js";
import { deskWriter, type WriteDesk } from "../ledger/desk-writer.js";
import { readerFor } from "../ledger/chain.js";
import type { DeskStore } from "../store.js";
import type { TraderKey } from "../traders.js";
import { chiefStage } from "./chief-stage.js";
import type { ApprovalQueue } from "../approvals.js";
import type { CoSignRequest } from "./chief-stage.js";
import { tryCase } from "../court/court.js";
import { CHIEF } from "../court/exhibits.js";
import { enforceSanctions, type Enforcement, type SanctionRequest } from "../court/sanctions.js";
import { surveil } from "../court/surveillance.js";
import { traders } from "../traders.js";
import { licenceDesk, runBeat, type BeatOutcome, type BuySignal, type RequestClearance } from "./engine.js";
import { paidClearance } from "./paid-clearance.js";
import { paidSignal } from "./paid-signal.js";
import { loadScenario } from "./scenario.js";

export type RunnerDeps = {
  store: DeskStore;
  coSign: ApprovalQueue<CoSignRequest>;
  sanctions: ApprovalQueue<SanctionRequest>;
  deskUrl: string;
  /** Which deployments/<name>.json signs and records against (EIP-712 domain). */
  deployment?: string;
  runtime?: AgentRuntime;
  requestClearance?: RequestClearance;
  buySignal?: BuySignal;
  writeDesk?: WriteDesk;
};

const keyOf = (name: string) => required(`${name}_PRIVATE_KEY`) as Hex;
export const traderAddress = (k: TraderKey): Address => privateKeyToAccount(keyOf(k)).address;

export async function runScenario(deps: RunnerDeps, scenarioId: string, beatIds?: string[]) {
  const scenario = loadScenario(scenarioId);
  const beats = beatIds ?? scenario.beats.map((b) => b.id);
  const runId = `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const deployment = deps.deployment ?? process.env.DEPLOYMENT ?? "base-sepolia";
  const dep = JSON.parse(readFileSync(`${ROOT}deployments/${deployment}.json`, "utf8")) as { chainId: number; deskLedger: Address };

  emit({ type: "scenario.started", runId, scenarioId: scenario.id, beats });
  try {
    const runtime = deps.runtime ?? runtimeFromEnv();
    const book = new DeskBook();
    const chief = privateKeyToAccount(keyOf("CHIEF"));
    const human = privateKeyToAccount(keyOf("HUMAN_APPROVER"));
    const domain = deskDomain(dep.chainId, dep.deskLedger);
    // In ledger mode the contract is the source of truth: what each write did, the Chief's auto-approve rule (a
    // judgment revokes it for 24 h, across runs) and each licence's status. Locally the run keeps that in memory.
    const ledgerMode = (process.env.CRE_DESK_TARGET ?? "local-simulation") !== "local-simulation";
    const reader = ledgerMode ? readerFor(dep) : undefined;
    const writeDesk = deps.writeDesk ?? deskWriter(reader);
    let autoApproveRevoked = false;
    const autoApproveActive = async () => (reader ? reader.autoApproveActive() : !autoApproveRevoked);
    const licenceActive = reader ? (k: TraderKey) => reader.licenceActive(traderAddress(k)) : undefined;
    const { policies } = await licenceDesk(runtime, deps.store, runId);
    const afterClearance = chiefStage({
      runtime,
      book,
      policies,
      writeDesk,
      chief,
      human,
      domain,
      addressOf: traderAddress,
      requestCoSign: deps.coSign.request,
      autoApproveActive,
      onRecorded: (t) => deps.store.recordTrade(t),
    });
    const outcomes: BeatOutcome[] = [];
    for (const beatId of beats) {
      outcomes.push(
        await runBeat(
          {
            runtime,
            store: deps.store,
            book,
            policies,
            runId,
            addressOf: traderAddress,
            licenceActive,
            requestClearance: deps.requestClearance ?? paidClearance(deps.deskUrl),
            buySignal: deps.buySignal ?? paidSignal(deps.deskUrl),
            resolveDeployment: (key) => {
              const all = JSON.parse(readFileSync(`${ROOT}deployments/${deployment}.json`, "utf8")) as Record<string, string>;
              if (!all[key]) throw new Error(`deployments/${deployment}.json has no ${key}`);
              return all[key];
            },
            afterClearance,
          },
          scenario,
          beatId,
        ),
      );
    }

    // Surveillance looks back over what this run recorded; any alert goes to court.
    const names = Object.fromEntries(traders.map((t) => [t.key, t.name]));
    const byAddress = new Map(traders.map((t) => [traderAddress(t.key).toLowerCase(), t.key]));
    const signalIds = new Set(deps.store.sales(runId).map((s) => s.signalId));
    const alerts = surveil({
      trades: deps.store.trades(runId),
      sales: deps.store.sales(runId),
      signals: new Map([...signalIds].map((id) => [id, deps.store.signal(id)!])),
      policies,
      names,
      traderOf: (a) => byAddress.get(a.toLowerCase()),
      allocationUsd: DESK.allocationUsd,
      autoApproveUsd: DESK.autoApproveUsd,
    });
    emit({ type: "surveillance.alerts", runId, alerts: alerts.map((a) => ({ code: a.code, trader: a.trader, symbol: a.symbol, detail: a.detail, unreviewed: a.unreviewed })) });

    let enforcement: Enforcement | undefined;
    const tried = await tryCase({ runtime, store: deps.store, policies, names, buyerName: (a) => names[byAddress.get(a.toLowerCase()) ?? ""] ?? a }, runId, alerts);
    if (tried) {
      const byName = new Map(traders.map((t) => [t.name, traderAddress(t.key)]));
      enforcement = await enforceSanctions(
        { approvals: deps.sanctions, human, domain, writeDesk, addressOf: (d) => (d === CHIEF ? chief.address : byName.get(d)!) },
        tried.file,
        tried.trail,
      );
      autoApproveRevoked ||= enforcement.revokedAutoApprove;
      emit({ type: "case.decided", runId, summary: tried.file.ruling.summary, approved: enforcement.approved, caseHash: enforcement.caseHash });
    }
    emit({ type: "scenario.finished", runId });
    return { runId, outcomes, book, alerts, case: tried?.file, enforcement };
  } catch (e) {
    emit({ type: "scenario.finished", runId, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
