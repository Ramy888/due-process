// x402 pay-per-call for the clearance checkpoint (protocol v2, Base Sepolia test USDC).
// Server side: an unpaid POST /clearance answers 402 with PAYMENT-REQUIRED; a paid retry carries PAYMENT-SIGNATURE
// (an EIP-3009 transfer authorisation signed by the trader's own wallet), which the facilitator verifies before the
// handler runs and settles after it succeeds. Client side: each trader agent pays from its own key.
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export const BASE_SEPOLIA = "eip155:84532";
export const USDC_BASE_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CLEARANCE_PRICE = "$0.01";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

export const facilitatorFromEnv = (): FacilitatorClient =>
  new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL });

/** Paywall for POST /clearance; fees go to `payTo` (the desk). */
export function clearancePaywall(opts: { payTo: Address; facilitator: FacilitatorClient }): MiddlewareHandler {
  const server = new x402ResourceServer(opts.facilitator).register(BASE_SEPOLIA, new ExactEvmServerScheme());
  return paymentMiddleware(
    {
      "POST /clearance": {
        accepts: [{ scheme: "exact", price: CLEARANCE_PRICE, network: BASE_SEPOLIA, payTo: opts.payTo }],
        description: "Due Process pre-trade clearance (Chainlink CRE workflow run)",
        mimeType: "application/json",
      },
    },
    server,
  );
}

export type Payment = { payer: Address; nonce: Hex };

/** Who paid for this request, and the EIP-3009 nonce that makes the payment unique on-chain.
 *  Only meaningful behind the paywall, which has already verified the signature. */
export function paymentOf(paymentSignatureHeader: string | undefined): Payment | undefined {
  if (!paymentSignatureHeader) return undefined;
  const a = JSON.parse(Buffer.from(paymentSignatureHeader, "base64").toString("utf8"))?.payload?.authorization;
  return a?.from && a?.nonce ? { payer: a.from, nonce: a.nonce } : undefined;
}

/** fetch that answers 402 challenges by signing from this trader's key. */
export function payingFetch(privateKey: Hex, fetchImpl: typeof fetch = fetch): typeof fetch {
  const client = new x402Client().register(BASE_SEPOLIA, new ExactEvmScheme(privateKeyToAccount(privateKey)));
  return wrapFetchWithPayment(fetchImpl, client);
}
