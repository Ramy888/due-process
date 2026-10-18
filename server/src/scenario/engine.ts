// Plays scenario beats: a trader reads its feed and proposes a trade, pays for clearance, and later stages (the Desk
// Chief, the ledger) act on the verdict. Every step lands on the beat's trail and on the event bus.
import type { Address, Hex } from "viem";
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

export type EngineDeps = {
  runtime: AgentRuntime;
  store: DeskStore;
  book: DeskBook;
  policies: ReadonlyMap<TraderKey, MandatePolicy>;
  requestClearance: RequestClearance;
  /** Distinguishes runs of the same scenario; part of every trail id. */
  runId: string;
  resolveDeployment?: (key: string) => string;
  afterClearance?: AfterClearance;
};

export type BeatOutcome = {
  beatId: string;
  trader: TraderKey;
  decision: TraderDecision;
  clearance?: ClearanceOutcome;
  after?: unknown;
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
  trail.append(trader.name, "trader.decision", { decision, replayKey: key, source });
  emit({ type: "trader.decision", beatId: beat.id, trader: trader.key, decision });

  const finish = (rest: Partial<BeatOutcome>): BeatOutcome => {
    const outcome = { beatId: beat.id, trader: trader.key, decision, trailId, trailHead: trail.head(), ...rest };
    emit({ type: "beat.finished", beatId: beat.id, verdict: outcome.clearance?.verdict ?? null, trailId, trailHead: outcome.trailHead });
    return outcome;
  };
  if (decision.action === "pass") return finish({});

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

  const clearance = await deps.requestClearance(trader.key, {
    chain: token.chain,
    token: token.address,
    notionalE6: String(Math.round(decision.notionalUsd * 1e6)),
    evidenceId,
  });
  trail.append("clearance-workflow", "clearance.verdict", {
    clearanceId: clearance.clearanceId,
    verdict: clearance.verdict,
    hits: clearance.hits,
    findingsHash: clearance.findingsHash,
    txHash: clearance.txHash,
    log: clearance.log ?? null,
  });

  const after = deps.afterClearance ? await deps.afterClearance({ scenario, beat, trader, decision, token, clearance, trail }) : undefined;
  return finish({ clearance, after });
}
