// Offline stand-in for https://x402.org/facilitator: checks the EIP-3009 signature the way USDC would and records
// settlements instead of sending them.
import { verifyTypedData, type Address, type Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import { BASE_SEPOLIA } from "../x402.js";

type Authorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };

export function localFacilitator(): FacilitatorClient & { settled: Authorization[] } {
  const settled: Authorization[] = [];
  return {
    settled,
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: BASE_SEPOLIA }], extensions: [], signers: {} };
    },
    async verify(payment, req) {
      const { authorization: a, signature } = payment.payload as { authorization: Authorization; signature: Hex };
      const ok =
        a.to === req.payTo &&
        a.value === req.amount &&
        (await verifyTypedData({
          address: a.from as Address,
          domain: { name: req.extra?.name as string, version: req.extra?.version as string, chainId: 84532, verifyingContract: req.asset as Address },
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } as never,
          signature,
        }));
      return ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: "invalid_signature", payer: a.from };
    },
    async settle(payment, req) {
      const a = (payment.payload as { authorization: Authorization }).authorization;
      settled.push(a);
      return { success: true, transaction: `0x${"ab".repeat(32)}`, network: req.network, payer: a.from };
    },
  };
}
