// Sends test USDC (or the local bond token) from the desk wallet to each of the five traders.
//   npx -w server tsx ../scripts/fund-traders.ts --deployment base-sepolia --usdc 0.5
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, required } from "../server/src/env.js";
import { fundTraders } from "../server/src/ops/fund.js";
import { traders } from "../server/src/traders.js";

const { values } = parseArgs({ options: { deployment: { type: "string", default: "base-sepolia" }, usdc: { type: "string", default: "0.5" } } });
const dep = JSON.parse(readFileSync(`${ROOT}deployments/${values.deployment}.json`, "utf8")) as { chainId: 84532 | 31337; bondToken: Address };
const results = await fundTraders({
  deskKey: required("DESK_PRIVATE_KEY") as Hex,
  token: dep.bondToken,
  traders: traders.map((t) => privateKeyToAccount(required(`${t.key}_PRIVATE_KEY`) as Hex).address),
  amountE6: BigInt(Math.round(Number(values.usdc) * 1e6)),
  chainId: dep.chainId,
  rpcUrl: process.env.LEDGER_RPC_URL,
});
for (const r of results) console.log(`${r.trader}  balance=${Number(r.balance) / 1e6}  tx=${r.txHash}`);
