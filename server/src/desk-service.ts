// What the UI talks to: starts a scenario run in the background, keeps per-trader counters from the event bus,
// and holds the two human approval queues (co-sign a large trade, approve a court's sanctions).
import type { Address } from "viem";
import { ApprovalQueue } from "./approvals.js";
import { subscribe, type DeskEvent } from "./bus.js";
import type { CaseFile } from "./court/court.js";
import { CHIEF } from "./court/exhibits.js";
import { SLASH_BOND, SUSPEND_LICENCE, type Enforcement, type SanctionRequest } from "./court/sanctions.js";
import { DESK, DeskBook, paperPnlUsd } from "./desk.js";
import type { CoSignRequest } from "./scenario/chief-stage.js";
import { newRunId, runScenario, traderAddress, type RunnerDeps } from "./scenario/runner.js";
import { loadScenario } from "./scenario/scenario.js";
import { CLEARANCE_PRICE, SIGNAL_PRICE } from "./x402.js";
import { chiefProfile, traders, type TraderKey } from "./traders.js";

const usd = (price: string) => Number(price.replace("$", ""));

type Counters = { approved: number; autoApproved: number; refused: number; rejectedByLedger: number; clearanceFeesUsd: number; signalsBoughtUsd: number; signalIncomeUsd: number };
const zero = (): Counters => ({ approved: 0, autoApproved: 0, refused: 0, rejectedByLedger: 0, clearanceFeesUsd: 0, signalsBoughtUsd: 0, signalIncomeUsd: 0 });

export type RunStatus = { runId: string | null; scenarioId: string | null; status: "idle" | "running" | "finished" | "failed"; error: string | null };

export type ServiceDeps = Omit<RunnerDeps, "coSign" | "sanctions" | "book"> & {
  /** Labels the UI shows so nobody mistakes a rehearsal for the real thing. */
  paymentsMode: "x402" | "offline";
  ledgerMode: "local-simulation" | "ledger";
  run?: typeof runScenario;
};

export class DeskService {
  readonly coSign = new ApprovalQueue<CoSignRequest>("cosign");
  readonly sanctions = new ApprovalQueue<SanctionRequest>("sanctions");
  private status: RunStatus = { runId: null, scenarioId: null, status: "idle", error: null };
  private book = new DeskBook();
  private counters = new Map<TraderKey, Counters>();
  private caseFile: CaseFile | undefined;
  private enforcement: Enforcement | undefined;
  private readonly byAddress: Map<string, TraderKey>;
  private readonly byName: Map<string, TraderKey>;

  constructor(private readonly deps: ServiceDeps) {
    this.byAddress = new Map(traders.map((t) => [traderAddress(t.key).toLowerCase(), t.key]));
    this.byName = new Map(traders.map((t) => [t.name, t.key]));
    subscribe((e) => this.count(e));
  }

  /** Starts a run in the background; the UI follows it over /events. */
  start(scenarioId: string, beats?: string[]): { runId: string } {
    if (this.status.status === "running") throw new Error("a scenario is already running");
    loadScenario(scenarioId); // fail fast on an unknown scenario
    const runId = newRunId(scenarioId);
    this.status = { runId, scenarioId, status: "running", error: null };
    this.book = new DeskBook();
    this.counters = new Map();
    this.caseFile = undefined;
    this.enforcement = undefined;
    const run = this.deps.run ?? runScenario;
    run({ ...this.deps, coSign: this.coSign, sanctions: this.sanctions, book: this.book }, scenarioId, beats, runId)
      .then((r) => {
        this.caseFile = r.case;
        this.enforcement = r.enforcement;
        this.status = { ...this.status, status: "finished" };
      })
      .catch((e: unknown) => {
        this.status = { ...this.status, status: "failed", error: e instanceof Error ? e.message : String(e) };
      });
    return { runId };
  }

  private counter(k: TraderKey): Counters {
    let c = this.counters.get(k);
    if (!c) this.counters.set(k, (c = zero()));
    return c;
  }

  private count(e: DeskEvent): void {
    if (this.status.status !== "running") return;
    if (e.type === "clearance.started") {
      const k = this.byAddress.get(e.trader.toLowerCase());
      if (k) this.counter(k).clearanceFeesUsd += usd(CLEARANCE_PRICE);
    } else if (e.type === "signal.sold") {
      const buyer = this.byAddress.get(e.buyer.toLowerCase());
      const seller = this.byName.get(e.seller);
      if (buyer) this.counter(buyer).signalsBoughtUsd += usd(SIGNAL_PRICE);
      if (seller) this.counter(seller).signalIncomeUsd += usd(SIGNAL_PRICE);
    } else if (e.type === "chief.decision") {
      const c = this.counter(e.trader);
      if (e.outcome === "approved") c.approved++;
      else if (e.outcome === "auto-approved") c.autoApproved++;
      else if (e.outcome === "refused") c.refused++;
    } else if (e.type === "ledger.write" && e.trader && !e.recorded) {
      this.counter(e.trader).rejectedByLedger++;
    }
  }

  /** Bond left and licence status after any judgment recorded in this run. */
  private standing(defendant: string): { bondUsd: number; licence: "active" | "suspended" } {
    let bondUsd: number = DESK.bondUsd;
    let licence: "active" | "suspended" = "active";
    for (const j of this.enforcement?.judgments ?? []) {
      if (j.defendant !== defendant || !j.recorded) continue;
      if (j.sanctions & SLASH_BOND) bondUsd = Math.max(0, bondUsd - j.slashUsd);
      if (j.sanctions & SUSPEND_LICENCE) licence = "suspended";
    }
    return { bondUsd, licence };
  }

  state() {
    const scenario = loadScenario(this.status.scenarioId ?? "frog-day");
    const tokens = scenario.tokens;
    return {
      run: this.status,
      desk: {
        ...DESK,
        paymentsMode: this.deps.paymentsMode,
        ledgerMode: this.deps.ledgerMode,
        autoApproveRevoked: this.enforcement?.revokedAutoApprove ?? false,
      },
      market: { label: scenario.snapshotLabel, tokens },
      traders: traders.map((t) => {
        const holdingsUsd = this.book.holdingsUsd(t.key);
        return {
          key: t.key,
          name: t.name,
          watches: t.watches,
          mandate: t.mandate,
          address: traderAddress(t.key) as Address,
          ...this.standing(t.name),
          allocationUsd: DESK.allocationUsd,
          spentUsd: this.book.spentUsd(t.key),
          holdingsUsd,
          pnlUsd: Math.round(paperPnlUsd(holdingsUsd, tokens) * 100) / 100,
          ...(this.counters.get(t.key) ?? zero()),
        };
      }),
      chief: { name: chiefProfile.name, mandate: chiefProfile.mandate, ...this.standing(CHIEF) },
      approvals: [
        ...this.coSign.list().map((a) => ({ kind: "cosign" as const, ...a })),
        ...this.sanctions.list().map((a) => ({ kind: "sanctions" as const, ...a })),
      ],
    };
  }

  case() {
    return this.caseFile ? { file: this.caseFile, enforcement: this.enforcement ?? null } : null;
  }
}
