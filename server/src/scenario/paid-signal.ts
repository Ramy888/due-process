// Buyer-side client for the signal market: the buying trader pays the selling trader's wallet over x402.
import type { Hex } from "viem";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { required } from "../env.js";
import { payingFetch } from "../x402.js";
import type { BuySignal } from "./engine.js";

const keyFromEnv = (trader: string) => required(`${trader}_PRIVATE_KEY`) as Hex;

export const paidSignal =
  (deskUrl: string, fetchImpl: typeof fetch = fetch, keyOf: (trader: string) => Hex = keyFromEnv): BuySignal =>
  async (buyer, signalId) => {
    const pay = payingFetch(keyOf(buyer), fetchImpl);
    const res = await pay(`${deskUrl}/signals/${encodeURIComponent(signalId)}`);
    const json = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`signal purchase failed (HTTP ${res.status}): ${json.error ?? "no detail"}`);
    const receipt = res.headers.get("payment-response");
    const settlementTx = receipt ? ((decodePaymentResponseHeader(receipt).transaction as Hex) ?? null) : null;
    return { text: String(json.text), settlementTx };
  };
