import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import { BASE_SEPOLIA, USDC_BASE_SEPOLIA, clearancePaywall, payerOf, payingFetch } from "./x402.js";

const DESK: Address = "0x4fAa2A586949D88C7d857a737Ace2C929dEb4f11";
const decode = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));

// Offline stand-in for https://x402.org/facilitator: checks the EIP-3009 signature the way USDC would, never settles.
const localFacilitator: FacilitatorClient = {
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: BASE_SEPOLIA }], extensions: [], signers: {} };
  },
  async verify(payment, req) {
    const { authorization: a, signature } = payment.payload as { authorization: Record<string, string>; signature: Hex };
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
    const a = (payment.payload as { authorization: { from: string } }).authorization;
    return { success: true, transaction: `0x${"ab".repeat(32)}`, network: req.network, payer: a.from };
  },
};

function gateway() {
  const app = new Hono();
  const seen: (Address | undefined)[] = [];
  app.use(clearancePaywall({ payTo: DESK, facilitator: localFacilitator }));
  app.post("/clearance", (c) => {
    seen.push(payerOf(c.req.header("payment-signature")));
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
