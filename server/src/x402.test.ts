import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { localFacilitator } from "./testing/local-facilitator.js";
import { BASE_SEPOLIA, USDC_BASE_SEPOLIA, deskPaywall, paymentOf, payingFetch } from "./x402.js";

const DESK: Address = "0x4fAa2A586949D88C7d857a737Ace2C929dEb4f11";
const decode = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));

function gateway() {
  const app = new Hono();
  const seen: (Address | undefined)[] = [];
  app.use(deskPaywall({ payTo: DESK, facilitator: localFacilitator() }));
  app.post("/clearance", (c) => {
    seen.push(paymentOf(c.req.header("payment-signature"))?.payer);
    return c.json({ cleared: true });
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  return { app, seen, fetchImpl };
}

const post = { method: "POST", body: "{}", headers: { "content-type": "application/json" } };

describe("x402 clearance paywall", () => {
  it("answers an unpaid call with 402 and 0.01 test USDC to the desk on Base Sepolia", async () => {
    const { app, seen } = gateway();
    const res = await app.request("/clearance", post);
    expect(res.status).toBe(402);
    const [req] = decode(res.headers.get("payment-required")).accepts;
    expect(req).toMatchObject({ scheme: "exact", network: BASE_SEPOLIA, asset: USDC_BASE_SEPOLIA, amount: "10000", payTo: DESK });
    expect(seen).toEqual([]);
  });

  it("lets a trader pay from its own wallet and tells the handler who paid", async () => {
    const { seen, fetchImpl } = gateway();
    const trader = generatePrivateKey();
    const res = await payingFetch(trader, fetchImpl)("http://desk/clearance", post);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: true });
    const receipt = decode(res.headers.get("payment-response"));
    expect(receipt).toMatchObject({ success: true, network: BASE_SEPOLIA, payer: privateKeyToAccount(trader).address });
    expect(seen).toEqual([privateKeyToAccount(trader).address]);
  });

  it("rejects a forged payment without reaching the handler", async () => {
    const { app, seen, fetchImpl } = gateway();
    // Capture a genuine signed payment, then claim it came from someone else.
    let header = "";
    const capture = ((input: RequestInfo | URL, init?: RequestInit) => {
      header = new Headers(input instanceof Request ? input.headers : init?.headers).get("payment-signature") ?? header;
      return fetchImpl(input, init);
    }) as typeof fetch;
    await payingFetch(generatePrivateKey(), capture)("http://desk/clearance", post);
    const forged = decode(header);
    forged.payload.authorization.from = privateKeyToAccount(generatePrivateKey()).address;
    seen.length = 0;

    const res = await app.request("/clearance", {
      ...post,
      headers: { ...post.headers, "payment-signature": Buffer.from(JSON.stringify(forged)).toString("base64") },
    });
    expect(res.status).toBe(402);
    expect(seen).toEqual([]);
  });
});
