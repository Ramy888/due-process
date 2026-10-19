import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex, type PublicClient } from "viem";
import { deskLedgerAbi } from "./abi.js";
import { ledgerReader } from "./chain.js";

const LEDGER = "0xcB6fAEd8B78ED4f3CEfA85D4D384804bB866687C";
const word = (n: string): Hex => `0x${n.repeat(64)}`;

/** A receipt holding one TradeRecorded log, as Base Sepolia returns it for a recorded $200 trade. */
const client = {
  waitForTransactionReceipt: async () => ({
    logs: [
      {
        address: LEDGER,
        topics: encodeEventTopics({
          abi: deskLedgerAbi,
          eventName: "TradeRecorded",
          args: { tradeId: word("1"), clearanceId: word("2"), trader: "0x1C615c1d11CD8F8A4158102D8813B2216D1B4905" },
        }),
        data: encodeAbiParameters(
          [{ type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "bool" }, { type: "bytes32" }],
          ["0x438c300f0000000000000000000000000000c0de", 0, 200_000_000n, false, word("3")],
        ),
        blockHash: word("4"), blockNumber: 1n, logIndex: 0, transactionHash: word("5"), transactionIndex: 0, removed: false,
      },
    ],
  }),
} as unknown as PublicClient;

describe("ledgerReader.events", () => {
  it("returns events that survive JSON (the event stream and the trails serialize them)", async () => {
    const events = await ledgerReader(client, LEDGER).events(word("5"));
    expect(events.map((e) => e.event)).toEqual(["TradeRecorded"]);
    expect(() => JSON.stringify(events)).not.toThrow();
    expect(events[0].args.notional).toBe("200000000");
  });
});
