// x402 pay-per-call for the clearance checkpoint (protocol v2, Base Sepolia test USDC).
// Server side: an unpaid POST /clearance answers 402 with PAYMENT-REQUIRED; a paid retry carries PAYMENT-SIGNATURE
// (an EIP-3009 transfer authorisation signed by the trader's own wallet), which the facilitator verifies before the
// handler runs and settles after it succeeds. Client side: each trader agent pays from its own key.
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export const BASE_SEPOLIA = "eip155:84532";
export const USDC_BASE_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CLEARANCE_PRICE = "$0.01";
export const SIGNAL_PRICE = "$0.05";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

export const facilitatorFromEnv = (): FacilitatorClient =>
  new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL });

/** Paywall for the desk's paid routes: clearance fees go to the desk; a signal's price goes to the trader selling it. */
export function deskPaywall(opts: {
  payTo: Address;
  facilitator: FacilitatorClient;
  /** Wallet of the trader selling a signal; unknown signals are priced to the desk and then answered 404 (no charge). */
  sellerOf?: (signalId: string) => Address | undefined;
}): MiddlewareHandler {
  const server = new x402ResourceServer(opts.facilitator).register(BASE_SEPOLIA, new ExactEvmServerScheme());
  const sellerPayTo = (ctx: { path: string }) => {
    const id = decodeURIComponent(ctx.path.split("/").pop() ?? "");
    return opts.sellerOf?.(id) ?? opts.payTo;
  };
  return paymentMiddleware(
    {
      "POST /clearance": {
        accepts: [{ scheme: "exact", price: CLEARANCE_PRICE, network: BASE_SEPOLIA, payTo: opts.payTo }],
        description: "Due Process pre-trade clearance (Chainlink CRE workflow run)",
        mimeType: "application/json",
      },
      "GET /signals/:id": {
        accepts: [{ scheme: "exact", price: SIGNAL_PRICE, network: BASE_SEPOLIA, payTo: sellerPayTo }],
        description: "A trading signal sold by one desk agent to another",
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

/** The facilitator's answer when a fee did not settle after the handler ran (a 402 carrying PAYMENT-RESPONSE). */
export function settleFailureOf(res: Response): SettleResponse | undefined {
  const header = res.headers.get("payment-response");
  if (res.status !== 402 || !header) return undefined;
  try {
    const settle = decodePaymentResponseHeader(header);
    return settle.success === false ? settle : undefined;
  } catch {
    return undefined;
  }
}

/** fetch that answers 402 challenges by signing from this trader's key. */
export function payingFetch(privateKey: Hex, fetchImpl: typeof fetch = fetch): typeof fetch {
  const client = new x402Client().register(BASE_SEPOLIA, new ExactEvmScheme(privateKeyToAccount(privateKey)));
  return wrapFetchWithPayment(fetchImpl, client);
}
