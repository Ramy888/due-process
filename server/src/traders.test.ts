import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { chiefProfile, mandateHash, traders } from "./traders.js";

describe("trader roster", () => {
  it("licenses five traders with distinct wallet keys, one per RYO-CHAN direction", () => {
    expect(traders.map((t) => t.key)).toEqual(["TRADER_KOL", "TRADER_WHALE", "TRADER_NEWS", "TRADER_MEME", "TRADER_DIP"]);
    expect(chiefProfile.key).toBe("CHIEF");
  });

  it("hashes mandates exactly as the deploy script registers them (keccak256 of the UTF-8 text)", () => {
    for (const t of traders) expect(mandateHash(t.mandate)).toBe(keccak256(stringToBytes(t.mandate)));
    // the Meme Hunter licence compiled live on 2026-10-18 (proof/t12-mandate-compiler-live.log)
    expect(mandateHash(traders[3].mandate)).toBe("0x6967e070da765c748d60358c94ea49fabdd8ffafae17baaacf1a57c529dce131");
  });
});
