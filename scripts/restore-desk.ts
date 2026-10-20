// Restores the desk after a judgment without redeploying: reinstates suspended licences (the human's call) and tops
// every bond back up from the desk wallet. The Chief's auto-approve comes back by itself 24 h after the judgment.
//   npx -w server tsx ../scripts/restore-desk.ts --deployment base-sepolia [--bond 1]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import { ROOT, required } from "../server/src/env.js";
import { deskLedgerAbi } from "../server/src/ledger/abi.js";
import { traders } from "../server/src/traders.js";

const { values } = parseArgs({ options: { deployment: { type: "string", default: "base-sepolia" }, bond: { type: "string", default: "1" } } });
const dep = JSON.parse(readFileSync(`${ROOT}deployments/${values.deployment}.json`, "utf8")) as { chainId: 84532 | 31337; deskLedger: Address; bondToken: Address };
const chain = { 84532: baseSepolia, 31337: foundry }[dep.chainId];
const transport = http(process.env.LEDGER_RPC_URL ?? chain.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain, transport });
const account = (name: string) => privateKeyToAccount(required(`${name}_PRIVATE_KEY`) as Hex);
const human = createWalletClient({ account: account("HUMAN_APPROVER"), chain, transport });
const desk = createWalletClient({ account: account("DESK"), chain, transport });
const ledgerAbi = [...deskLedgerAbi, ...parseAbi(["function reinstate(address trader)", "function postBond(address trader, uint256 amount)", "function autoApproveSuspendedUntil() view returns (uint256)"])];
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const SUSPENDED = 2;
const target = BigInt(Math.round(Number(values.bond) * 1e6));

const send = async (label: string, tx: Promise<Hex>) => {
  const hash = await tx;
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed (${hash})`);
  console.log(`${label}  tx=${hash}`);
};

const licensees = [...traders.map((t) => ({ name: t.name, address: account(t.key).address })), { name: "Desk Chief", address: account("CHIEF").address }];
const shortfalls: { name: string; address: Address; amount: bigint }[] = [];
for (const l of licensees) {
  const licence = await pub.readContract({ address: dep.deskLedger, abi: ledgerAbi, functionName: "licenceOf", args: [l.address] });
  if (licence.status === SUSPENDED) await send(`reinstate ${l.name}`, human.writeContract({ address: dep.deskLedger, abi: ledgerAbi, functionName: "reinstate", args: [l.address] }));
  if (licence.bond < target) shortfalls.push({ ...l, amount: target - licence.bond });
}
if (shortfalls.length) {
  const total = shortfalls.reduce((s, x) => s + x.amount, 0n);
  await send(`approve ${Number(total) / 1e6} USDC for bonds`, desk.writeContract({ address: dep.bondToken, abi: erc20, functionName: "approve", args: [dep.deskLedger, total] }));
  for (const s of shortfalls) {
    await send(`bond ${s.name} +${Number(s.amount) / 1e6}`, desk.writeContract({ address: dep.deskLedger, abi: ledgerAbi, functionName: "postBond", args: [s.address, s.amount] }));
  }
}
const until = Number(await pub.readContract({ address: dep.deskLedger, abi: ledgerAbi, functionName: "autoApproveSuspendedUntil" }));
const left = until - Math.floor(Date.now() / 1000);
console.log(left > 0 ? `auto-approve is still revoked until ${new Date(until * 1000).toISOString()} (${Math.ceil(left / 60)} min)` : "auto-approve is active");
