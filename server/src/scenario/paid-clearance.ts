// Trader-side client for the desk's clearance checkpoint: each trader pays the x402 fee from its own wallet.
import type { Hex } from "viem";
import { required } from "../env.js";
import { payingFetch } from "../x402.js";
import type { ClearanceOutcome, RequestClearance } from "./engine.js";

export const paidClearance =
  (deskUrl: string, fetchImpl: typeof fetch = fetch): RequestClearance =>
  async (trader, body) => {
    const pay = payingFetch(required(`${trader}_PRIVATE_KEY`) as Hex, fetchImpl);
    const res = await pay(`${deskUrl}/clearance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`clearance failed (HTTP ${res.status}): ${json.detail ?? json.error ?? "no detail"}`);
    return json as ClearanceOutcome;
  };
