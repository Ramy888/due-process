// Plays scenario beats: a trader reads its feed and proposes a trade, pays for clearance, and later stages (the Desk
// Chief, the ledger) act on the verdict. Every step lands on the beat's trail and on the event bus.
import type { Address, Hex } from "viem";
import { SIGNAL_PRICE } from "../x402.js";
import { compileMandate, type CompiledMandate, type MandatePolicy } from "../agents/mandate.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { decide, type TraderDecision } from "../agents/trader.js";
import type { Trail } from "../agents/trail.js";
import type { ClearanceResult } from "../clearance.js";
import { DESK, type DeskBook } from "../desk.js";
import { emit } from "../bus.js";
import { evidenceFor, putEvidence } from "../evidence.js";
import { personas } from "../personas.js";
import type { DeskStore } from "../store.js";
import { deskRules, traders, type TraderKey, type TraderProfile } from "../traders.js";
import { deploymentAddress, promotersOf, tokenAddress, type Beat, type Scenario } from "./scenario.js";

export type ClearanceRequestBody = { chain: "solana" | "base-sepolia"; token: string; notionalE6: string; evidenceId: string };
export type ClearanceOutcome = ClearanceResult & { log?: string };
export type RequestClearance = (trader: TraderKey, body: ClearanceRequestBody) => Promise<ClearanceOutcome>;

export type BeatContext = {
  runId: string;
  scenario: Scenario;
  beat: Beat;
  trader: TraderProfile;
  decision: TraderDecision;
  token: { symbol: string; chain: "solana" | "base-sepolia"; address: string };
  clearance: ClearanceOutcome;
  trail: Trail;
};
/** What happens after clearance (the Desk Chief, then the ledger). Plugged in by later stages. */
export type AfterClearance = (ctx: BeatContext) => Promise<unknown>;

export type SignalPurchase = { text: string; settlementTx: Hex | null };
/** A trader buys another trader's signal over x402, paying the seller's wallet. */
export type BuySignal = (buyer: TraderKey, signalId: string) => Promise<SignalPurchase>;

export type EngineDeps = {
  runtime: AgentRuntime;
  store: DeskStore;
  book: DeskBook;
  policies: ReadonlyMap<TraderKey, MandatePolicy>;
  requestClearance: RequestClearance;
  /** Distinguishes runs of the same scenario; part of every trail id. */
  runId: string;
  addressOf: (trader: TraderKey) => Address;
  /** In ledger mode, whether DeskLedger still holds the trader's licence active; a suspended trader cannot trade. */
  licenceActive?: (trader: TraderKey) => Promise<boolean>;
  buySignal?: BuySignal;
  resolveDeployment?: (key: string) => string;
  afterClearance?: AfterClearance;
};

export type BeatStep = { decision: TraderDecision; clearance?: ClearanceOutcome; after?: unknown; failed?: string };

export type BeatOutcome = {
  beatId: string;
  trader: TraderKey;
  steps: BeatStep[];
  signalId?: string;
  trailId: string;
  trailHead: Hex;
};

const profileOf = (key: TraderKey) => {
  const p = traders.find((t) => t.key === key);
  if (!p) throw new Error(`no trader ${key} in data/traders.json`);
  return p;
};

/** Compiles every trader's mandate (cached after the first run) and records the licences on one trail. */
export async function licenceDesk(runtime: AgentRuntime, store: DeskStore, runId: string) {
  const trail = store.openTrail(`${runId}:licensing`);
  const compiled = new Map<TraderKey, CompiledMandate>();
  for (const t of traders) {
    compiled.set(t.key, await compileMandate(runtime, trail, { trader: t.name, mandate: t.mandate, allocationUsd: DESK.allocationUsd, deskRules }));
  }
  return { compiled, policies: new Map([...compiled].map(([k, c]) => [k, c.policy])), trail };
}

export async function runBeat(deps: EngineDeps, scenario: Scenario, beatId: string): Promise<BeatOutcome> {
  const beat = scenario.beats.find((b) => b.id === beatId);
  if (!beat) throw new Error(`scenario ${scenario.id} has no beat ${beatId}`);
  const trader = profileOf(beat.trader);
  const limits = deps.policies.get(trader.key);
  if (!limits) throw new Error(`${trader.name} has no compiled licence; run licenceDesk first`);
  const resolve = deps.resolveDeployment ?? deploymentAddress;

  const trailId = `${deps.runId}:${beat.id}`;
  const trail = deps.store.openTrail(trailId);
  emit({ type: "beat.started", beatId: beat.id, title: beat.title, trader: trader.key });
  trail.append("desk", "beat.started", { beat: beat.id, title: beat.title, trader: trader.name, feed: beat.feed });
  if (deps.licenceActive && !(await deps.licenceActive(trader.key))) {
    trail.append("desk", "beat.skipped", { why: `${trader.name}'s licence is suspended on DeskLedger` });
    emit({ type: "beat.finished", beatId: beat.id, verdict: null, trailId, trailHead: trail.head() });
    return { beatId: beat.id, trader: trader.key, steps: [], trailId, trailHead: trail.head() };
  }

  let signalId: string | undefined;
  if (beat.signalSale) signalId = await sellSignal(deps, beat, trader, trail);

  // Each proposal is announced just before it is checked, so staged orders interleave with their clearances.
  const decisions: { decision: TraderDecision; announce: () => void }[] = [];
  if (beat.staged) {
    const { label, orders } = beat.staged;
    for (const o of orders) {
      const decision: TraderDecision = { action: "trade", symbol: o.symbol, side: o.side, notionalUsd: o.notionalUsd, reasoning: o.note, evidence: [] };
      decisions.push({
        decision,
        announce: () => {
          trail.append(trader.name, "trader.order", { staged: true, label, order: o });
          emit({ type: "trader.decision", beatId: beat.id, trader: trader.key, decision, staged: true });
        },
      });
    }
  } else {
    const market = Object.fromEntries(
      beat.candidates.map((sym) => {
        const { chain, priceUsd, liquidityUsd, change24hPct } = scenario.tokens[sym];
        return [sym, { chain, priceUsd, liquidityUsd, change24hPct }];
      }),
    );
    const { decision, key, source } = await decide(deps.runtime, {
      trader,
      limits,
      allocationUsd: DESK.allocationUsd,
      spentUsd: deps.book.spentUsd(trader.key),
      holdingsUsd: deps.book.holdingsUsd(trader.key),
      feed: beat.feed,
      market,
    });
    decisions.push({
      decision,
      announce: () => {
        trail.append(trader.name, "trader.decision", { decision, replayKey: key, source });
        emit({ type: "trader.decision", beatId: beat.id, trader: trader.key, decision, staged: false });
      },
    });
  }

  const steps: BeatStep[] = [];
  for (const { decision, announce } of decisions) {
    announce();
    if (decision.action === "pass") {
      steps.push({ decision });
      continue;
    }
    steps.push(await clearAndAct(deps, scenario, beat, trader, decision, trail, resolve));
  }

  const outcome: BeatOutcome = { beatId: beat.id, trader: trader.key, steps, signalId, trailId, trailHead: trail.head() };
  emit({ type: "beat.finished", beatId: beat.id, verdict: steps.at(-1)?.clearance?.verdict ?? null, trailId, trailHead: outcome.trailHead });
  return outcome;
}

async function sellSignal(deps: EngineDeps, beat: Beat, seller: TraderProfile, trail: Trail): Promise<string> {
  const sale = beat.signalSale!;
  if (!deps.buySignal) throw new Error(`beat ${beat.id} sells a signal but no buySignal client is configured`);
  const id = `${deps.runId}-${beat.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  deps.store.putSignal({
    id,
    runId: deps.runId,
    seller: seller.name,
    sellerAddress: deps.addressOf(seller.key),
    symbol: sale.symbol,
    text: sale.text,
    priceUsd: Number(SIGNAL_PRICE.slice(1)),
    createdAt: new Date().toISOString(),
  });
  trail.append(seller.name, "signal.offered", { signalId: id, symbol: sale.symbol, text: sale.text, priceUsd: SIGNAL_PRICE });
  for (const buyer of sale.buyers) {
    const bought = await deps.buySignal(buyer, id);
    if (bought.settlementTx) deps.store.attachSettlement(id, deps.addressOf(buyer), bought.settlementTx);
    trail.append(profileOf(buyer).name, "signal.bought", { signalId: id, seller: seller.name, settlementTx: bought.settlementTx });
  }
  return id;
}

async function clearAndAct(
  deps: EngineDeps,
  scenario: Scenario,
  beat: Beat,
  trader: TraderProfile,
  decision: TraderDecision,
  trail: Trail,
  resolve: (key: string) => string,
): Promise<BeatStep> {
  const tok = scenario.tokens[decision.symbol];
  const token = { symbol: decision.symbol, chain: tok.chain, address: tokenAddress(tok, resolve) };
  // The desk's private evidence for this check: which personas pushed the token, and who deployed it if it is ours.
  const promoters = promotersOf(beat, decision.symbol);
  const evidenceId = `${beat.id}-${decision.symbol}`.toLowerCase();
  putEvidence(
    evidenceId,
    evidenceFor(
      personas.filter((p) => promoters.includes(p.handle)),
      tok.staged ? (resolve("frogDeployer") as Address) : undefined,
    ),
  );

  let clearance: ClearanceOutcome;
  try {
    clearance = await deps.requestClearance(trader.key, {
      chain: token.chain,
      token: token.address,
      notionalE6: String(Math.round(decision.notionalUsd * 1e6)),
      evidenceId,
    });
  } catch (e) {
    // The checkpoint could not run (the gateway does not charge for that); the proposal goes no further.
    const failed = e instanceof Error ? e.message : String(e);
    trail.append("clearance-workflow", "clearance.failed", { symbol: decision.symbol, error: failed });
    return { decision, failed };
  }
  trail.append("clearance-workflow", "clearance.verdict", {
    clearanceId: clearance.clearanceId,
    verdict: clearance.verdict,
    hits: clearance.hits,
    findingsHash: clearance.findingsHash,
    txHash: clearance.txHash,
    log: clearance.log ?? null,
  });

  const after = deps.afterClearance ? await deps.afterClearance({ runId: deps.runId, scenario, beat, trader, decision, token, clearance, trail }) : undefined;
  return { decision, clearance, after };
}
