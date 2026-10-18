// Runs a whole scenario with the real desk wiring: licences, beats, paid clearance and signals over HTTP to the desk
// server, the Desk Chief stage, the Desk Writer workflow, and the human co-sign queue.
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runtimeFromEnv, type AgentRuntime } from "../agents/runtime.js";
import { emit } from "../bus.js";
import { DeskBook } from "../desk.js";
import { ROOT, required } from "../env.js";
import { deskDomain } from "../ledger/eip712.js";
import { writeDeskWithCre, type WriteDesk } from "../ledger/desk-writer.js";
import type { DeskStore } from "../store.js";
import type { TraderKey } from "../traders.js";
import { chiefStage } from "./chief-stage.js";
import type { CoSignQueue } from "./cosign.js";
import { licenceDesk, runBeat, type BeatOutcome, type BuySignal, type RequestClearance } from "./engine.js";
import { paidClearance } from "./paid-clearance.js";
import { paidSignal } from "./paid-signal.js";
import { loadScenario } from "./scenario.js";

export type RunnerDeps = {
  store: DeskStore;
  coSign: CoSignQueue;
  deskUrl: string;
  /** Which deployments/<name>.json signs and records against (EIP-712 domain). */
  deployment?: string;
  runtime?: AgentRuntime;
  requestClearance?: RequestClearance;
  buySignal?: BuySignal;
  writeDesk?: WriteDesk;
  autoApproveActive?: () => boolean;
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
    const { policies } = await licenceDesk(runtime, deps.store, runId);
    const afterClearance = chiefStage({
      runtime,
      book,
      policies,
      writeDesk: deps.writeDesk ?? writeDeskWithCre,
      chief: privateKeyToAccount(keyOf("CHIEF")),
      human: privateKeyToAccount(keyOf("HUMAN_APPROVER")),
      domain: deskDomain(dep.chainId, dep.deskLedger),
      addressOf: traderAddress,
      requestCoSign: deps.coSign.request,
      autoApproveActive: deps.autoApproveActive ?? (() => true),
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
    emit({ type: "scenario.finished", runId });
    return { runId, outcomes, book };
  } catch (e) {
    emit({ type: "scenario.finished", runId, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
