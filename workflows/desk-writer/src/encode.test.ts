import { describe, expect, it } from "bun:test";
import { decodeAbiParameters, keccak256, parseAbiParameters, stringToBytes } from "viem";
import { encodeRequest, requestSchema } from "./encode";

const id = `0x${"0b".repeat(32)}` as const;
const trader = "0x1C615c1d11CD8F8A4158102D8813B2216D1B4905";
const trail = `0x${"11".repeat(32)}` as const;
const sig = `0x${"ab".repeat(65)}` as const;

describe("desk writer encoding", () => {
  it("encodes a Chief refusal as Action.Refusal with the hash of the exact reason text", () => {
    const reason = "Two other traders already hold this token; the desk would be too concentrated.";
    const req = requestSchema.parse({ kind: "refusal", refusal: { clearanceId: id, trader, trailHash: trail }, reason, chiefSig: sig });
    const { action, body } = encodeRequest(req);
    expect(action).toBe(3);
    const [r, text, chiefSig] = decodeAbiParameters(parseAbiParameters("(bytes32,address,bytes32,bytes32), string, bytes"), body);
    expect(r).toEqual([id, trader, keccak256(stringToBytes(reason)), trail]);
    expect(text).toBe(reason);
    expect(chiefSig).toBe(sig);
  });

  it("encodes a trade as Action.Trade with both signatures", () => {
    const req = requestSchema.parse({
      kind: "trade",
      trade: { clearanceId: id, trader, token: trader, side: 0, notionalE6: "500000000", nonce: "7", trailHash: trail },
      chiefSig: sig,
      humanSig: "0x",
    });
    const { action, body } = encodeRequest(req);
    expect(action).toBe(1);
    const [t, chiefSig, humanSig] = decodeAbiParameters(parseAbiParameters("(bytes32,address,address,uint8,uint256,uint256,bytes32), bytes, bytes"), body);
    expect(t).toEqual([id, trader, trader, 0, 500000000n, 7n, trail]);
    expect([chiefSig, humanSig]).toEqual([sig, "0x"]);
  });

  it("rejects a refusal without a reason", () => {
    expect(() => requestSchema.parse({ kind: "refusal", refusal: { clearanceId: id, trader, trailHash: trail }, reason: "", chiefSig: sig })).toThrow();
  });
});
