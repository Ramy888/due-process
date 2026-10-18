import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deskDomain, deskTypes, reasonHash, signRefusal, signTrade, type TradeMessage } from "./eip712.js";

const domain = deskDomain(84532, "0xA31F6ec1aBE778FC9D7c202272b40b018554B627");
const h = (b: string) => `0x${b.repeat(32)}` as const;

describe("desk EIP-712 signatures", () => {
  it("a Chief-signed trade recovers to the Chief and to no one else after any change", async () => {
    const chief = privateKeyToAccount(generatePrivateKey());
    const message: TradeMessage = { clearanceId: h("0b"), trader: chief.address, token: chief.address, side: 0, notional: 90_000_000n, nonce: 1n, trailHash: h("11") };
    const signature = await signTrade(chief, domain, message);
    const recover = (m: TradeMessage) => recoverTypedDataAddress({ domain, types: deskTypes, primaryType: "Trade", message: m, signature });
    expect(await recover(message)).toBe(chief.address);
    expect(await recover({ ...message, notional: 91_000_000n })).not.toBe(chief.address);
  });

  it("a refusal commits to the exact reason text", async () => {
    const chief = privateKeyToAccount(generatePrivateKey());
    const message = { clearanceId: h("0c"), trader: chief.address, reasonHash: reasonHash("too concentrated"), trailHash: h("22") };
    const signature = await signRefusal(chief, domain, message);
    const recovered = await recoverTypedDataAddress({
      domain, types: deskTypes, primaryType: "Refusal", signature,
      message: { ...message, reasonHash: reasonHash("too concentrated!") },
    });
    expect(recovered).not.toBe(chief.address);
  });
});
