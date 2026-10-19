// Trader-side client for the desk's clearance checkpoint: each trader pays the x402 fee from its own wallet.
import type { Hex } from "viem";
import { required } from "../env.js";
import type { TraderKey } from "../traders.js";
import { payingFetch, settleFailureOf } from "../x402.js";
import type { ClearanceOutcome, RequestClearance } from "./engine.js";

export const paidClearance =
  (deskUrl: string, fetchImpl: typeof fetch = fetch, keyOf = (t: TraderKey) => required(`${t}_PRIVATE_KEY`) as Hex): RequestClearance =>
  async (trader, body) => {
    const pay = payingFetch(keyOf(trader), fetchImpl);
    const ask = () =>
      pay(`${deskUrl}/clearance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let res = await ask();
    // The public facilitator now and then fails to settle a fee after the check ran. An empty transaction most likely
    // means nothing was sent, so pay once more (a new nonce, so a new check). That is not a guarantee: an RPC can accept
    // a transaction the facilitator then reports as failed, and the first authorisation stays valid for minutes, so the
    // worst case is a $0.02 fee in test USDC. With a transaction named, or no answer at all, the trade stops instead.
    const unsettled = settleFailureOf(res);
    if (unsettled && !unsettled.transaction) res = await ask();
    const json = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      const failed = settleFailureOf(res);
      const why = failed ? `the $0.01 fee did not settle (${failed.errorReason ?? "no reason given"})` : (json.detail ?? json.error ?? "no detail");
      throw new Error(`clearance failed (HTTP ${res.status}): ${why}`);
    }
    return json as ClearanceOutcome;
  };
