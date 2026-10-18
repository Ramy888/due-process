import { describe, expect, it } from "vitest";
import { ledgerVerdict, type DeskWriteResult } from "./desk-writer.js";

const ledger = (events: DeskWriteResult["events"], txHash: `0x${string}` | null = `0x${"1".repeat(64)}`): DeskWriteResult => ({
  kind: "trade", mode: "ledger", txHash, log: "x.log", events,
});

describe("ledgerVerdict", () => {
  it("accepts only the success event, and passes the contract's own rejection reason through", () => {
    expect(ledgerVerdict(ledger([{ event: "TradeRecorded", args: {} }]), "TradeRecorded")).toEqual({ ok: true });
    expect(ledgerVerdict(ledger([{ event: "TradeRejected", args: { reason: "CHIEF_APPROVAL_MISSING" } }]), "TradeRecorded")).toEqual({
      ok: false,
      reason: "CHIEF_APPROVAL_MISSING",
    });
  });

  it("does not count a transaction without a DeskLedger outcome, or a dry run, as recorded", () => {
    expect(ledgerVerdict(ledger([]), "TradeRecorded")).toMatchObject({ ok: false, reason: /no DeskLedger outcome/ });
    expect(ledgerVerdict(ledger(undefined, null), "JudgmentRecorded")).toMatchObject({ ok: false, reason: /dry run/ });
  });

  it("has nothing to contradict in local simulation", () => {
    expect(ledgerVerdict({ kind: "trade", mode: "local-simulation", txHash: null, log: "x" }, "TradeRecorded")).toEqual({ ok: true });
  });
});
