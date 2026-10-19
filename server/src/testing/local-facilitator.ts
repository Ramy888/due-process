// Offline stand-in for https://x402.org/facilitator: checks the EIP-3009 signature the way USDC would and records
// settlements instead of sending them.
import { verifyTypedData, type Address, type Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import { BASE_SEPOLIA } from "../x402.js";

type Authorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };

/** A settlement the facilitator reports as failed; `transaction` set means it sent one that may still land. */
export type SettleFailure = { errorReason: string; transaction?: string };

/**
 * `failSettles`: the first settlements fail like this, in order (the public facilitator does, now and then); an Error
 * in the list is thrown instead, the way a facilitator timeout surfaces.
 */
export function localFacilitator({ failSettles = [] }: { failSettles?: (SettleFailure | Error)[] } = {}): FacilitatorClient & { settled: Authorization[] } {
  const settled: Authorization[] = [];
  const failures = [...failSettles];
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
      const failure = failures.shift();
      if (failure instanceof Error) throw failure;
      if (failure) return { success: false, transaction: "", ...failure, network: req.network, payer: a.from };
      settled.push(a);
      return { success: true, transaction: `0x${"ab".repeat(32)}`, network: req.network, payer: a.from };
    },
  };
}
