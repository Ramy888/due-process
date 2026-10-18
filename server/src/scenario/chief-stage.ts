// After clearance: the Desk Chief approves (EIP-712 signature) or refuses (signed refusal), small clean trades pass
// on the auto-approve rule without review, large ones wait for the human co-signature, and the Desk Writer workflow
// records the result on DeskLedger. The contract re-checks every signature and limit itself.
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { reviewTrade } from "../agents/chief.js";
import { checkMandate, type MandatePolicy } from "../agents/mandate.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { emit } from "../bus.js";
import { ledgerTokenFor } from "../clearance.js";
import { DESK, type DeskBook } from "../desk.js";
import { deskDomain, reasonHash, signRefusal, signTrade, tradeDigest, type TradeMessage } from "../ledger/eip712.js";
import type { WriteDesk } from "../ledger/desk-writer.js";
import { traders, type TraderKey } from "../traders.js";
import type { AfterClearance, BeatContext } from "./engine.js";

export type ChiefOutcome =
  | { outcome: "blocked" }
  | { outcome: "refused"; reason: string; txHash: Hex | null }
  | { outcome: "cosign-declined"; reason: string }
  | { outcome: "approved" | "auto-approved"; tradeId: Hex; txHash: Hex | null };

export type CoSignRequest = { beatId: string; trader: TraderKey; symbol: string; notionalUsd: number; reason: string };

export type ChiefStageDeps = {
  runtime: AgentRuntime;
  book: DeskBook;
  policies: ReadonlyMap<TraderKey, MandatePolicy>;
  writeDesk: WriteDesk;
  chief: LocalAccount;
  /** The human approver's key, held by the desk server behind the UI's co-sign button. */
  human: LocalAccount;
  domain: ReturnType<typeof deskDomain>;
  addressOf: (trader: TraderKey) => Address;
  /** Resolves when the human decides; the desk never co-signs on its own. */
  requestCoSign: (req: CoSignRequest) => Promise<boolean>;
  /** False while a judgment has revoked the Chief's auto-approve rule. */
  autoApproveActive: () => boolean;
  nonce?: () => bigint;
};

const toE6 = (usd: number) => BigInt(Math.round(usd * 1e6));

export const chiefStage =
  (deps: ChiefStageDeps): AfterClearance =>
  async (ctx: BeatContext): Promise<ChiefOutcome> => {
    const { beat, trader, decision, token, clearance, trail } = ctx;
    const done = (o: ChiefOutcome, reason = "", concerns: string[] = []) => {
      emit({ type: "chief.decision", beatId: beat.id, trader: trader.key, outcome: o.outcome, reason, concerns });
      return o;
    };

    if (clearance.verdict === "BLOCKED") {
      trail.append("desk", "chief.skipped", { why: "clearance BLOCKED; the trade cannot be recorded" });
      return done({ outcome: "blocked" }, "Clearance blocked the trade.");
    }

    const notional = toE6(decision.notionalUsd);
    const trade: TradeMessage = {
      clearanceId: clearance.clearanceId,
      trader: deps.addressOf(trader.key),
      token: ledgerTokenFor(token.chain, token.address),
      side: decision.side === "buy" ? 0 : 1,
      notional,
      nonce: deps.nonce?.() ?? BigInt(`0x${randomBytes(8).toString("hex")}`),
      trailHash: "0x" as Hex, // set below, once the review is on the trail
    };

    const auto = clearance.verdict === "CLEARED" && decision.notionalUsd <= DESK.autoApproveUsd && deps.autoApproveActive();
    let reason = `Auto-approved: cleared and at most $${DESK.autoApproveUsd}, under the Chief's standing rule.`;
    let concerns: string[] = [];
    if (auto) {
      trail.append("desk", "chief.auto-approved", { rule: `cleared trades up to $${DESK.autoApproveUsd} need no review`, notionalUsd: decision.notionalUsd });
    } else {
      const policy = deps.policies.get(trader.key);
      if (!policy) throw new Error(`${trader.name} has no compiled licence`);
      const held = deps.book.holdingsUsd(trader.key)[token.symbol] ?? 0;
      const brokenLimits = checkMandate(policy, DESK.allocationUsd, {
        chain: token.chain,
        token: token.address,
        notionalUsd: decision.notionalUsd,
        positionAfterUsd: decision.side === "buy" ? held + decision.notionalUsd : Math.max(0, held - decision.notionalUsd),
        liquidityUsd: ctx.scenario.tokens[token.symbol].liquidityUsd,
        tradesInLastHour: deps.book.tradeCount(trader.key),
        minutesSinceSoldSignal: null, // a signal sale is only visible to surveillance afterwards
      });
      const names = Object.fromEntries(traders.map((t) => [t.key, t.name]));
      const deskHoldings = Object.fromEntries(Object.entries(deps.book.all()).map(([k, h]) => [names[k] ?? k, h]));
      const { output, key, source } = await reviewTrade(deps.runtime, {
        trader: { name: trader.name, mandate: trader.mandate, limits: policy, allocationUsd: DESK.allocationUsd, spentUsd: deps.book.spentUsd(trader.key) },
        proposal: { symbol: decision.symbol, side: decision.side, notionalUsd: decision.notionalUsd, reasoning: decision.reasoning },
        brokenLimits,
        clearance: { verdict: clearance.verdict, findings: clearance.hits.map((h) => `${h.code}: ${h.detail}`) },
        deskHoldings,
      });
      reason = output.reason;
      concerns = output.concerns;
      trail.append("Desk Chief", "chief.review", { ...output, brokenLimits, replayKey: key, source });

      if (!output.approve) {
        const refusal = { clearanceId: clearance.clearanceId, trader: trade.trader, trailHash: trail.head() };
        const chiefSig = await signRefusal(deps.chief, deps.domain, { ...refusal, reasonHash: reasonHash(reason) });
        const written = await deps.writeDesk({ kind: "refusal", refusal, reason, chiefSig });
        trail.append("desk-writer", "ledger.refusal", { txHash: written.txHash, mode: written.mode, log: written.log });
        emit({ type: "ledger.write", beatId: beat.id, ...written });
        return done({ outcome: "refused", reason, txHash: written.txHash }, reason, concerns);
      }
    }

    trade.trailHash = trail.head();
    const chiefSig: Hex = auto ? "0x" : await signTrade(deps.chief, deps.domain, trade);
    let humanSig: Hex = "0x";
    if (decision.notionalUsd > DESK.coSignUsd) {
      emit({ type: "cosign.requested", beatId: beat.id, trader: trader.key, symbol: token.symbol, notionalUsd: decision.notionalUsd });
      const approved = await deps.requestCoSign({ beatId: beat.id, trader: trader.key, symbol: token.symbol, notionalUsd: decision.notionalUsd, reason });
      trail.append("human", approved ? "cosign.approved" : "cosign.declined", { notionalUsd: decision.notionalUsd });
      if (!approved) return done({ outcome: "cosign-declined", reason: "The human approver declined to co-sign." }, reason, concerns);
      humanSig = await signTrade(deps.human, deps.domain, trade);
    }

    const written = await deps.writeDesk({
      kind: "trade",
      trade: { ...trade, notionalE6: notional.toString(), nonce: trade.nonce.toString() },
      chiefSig,
      humanSig,
    });
    deps.book.record(trader.key, token.symbol, decision.side, decision.notionalUsd);
    const tradeId = tradeDigest(deps.domain, trade);
    trail.append("desk-writer", "ledger.trade", { tradeId, autoApproved: auto, txHash: written.txHash, mode: written.mode, log: written.log });
    emit({ type: "ledger.write", beatId: beat.id, ...written });
    return done({ outcome: auto ? "auto-approved" : "approved", tradeId, txHash: written.txHash }, reason, concerns);
  };
