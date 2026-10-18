// Moves test USDC from the desk wallet to each trader, so traders can pay x402 fees from their own wallets.
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const CHAINS = { 84532: baseSepolia, 31337: foundry } as const;

export async function fundTraders(opts: { deskKey: Hex; token: Address; traders: Address[]; amountE6: bigint; chainId: 84532 | 31337; rpcUrl?: string }) {
  const chain = CHAINS[opts.chainId];
  const transport = http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const desk = privateKeyToAccount(opts.deskKey);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account: desk, chain, transport });
  const need = opts.amountE6 * BigInt(opts.traders.length);
  const have = await pub.readContract({ address: opts.token, abi: erc20, functionName: "balanceOf", args: [desk.address] });
  if (have < need) throw new Error(`desk holds ${have} (6 decimals) but funding needs ${need}`);
  const out: { trader: Address; txHash: Hex; balance: bigint }[] = [];
  for (const trader of opts.traders) {
    const txHash = await wallet.writeContract({ address: opts.token, abi: erc20, functionName: "transfer", args: [trader, opts.amountE6] });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`USDC transfer to ${trader} failed (${txHash})`);
    // read at the transfer's block: a load-balanced public RPC can otherwise answer from a node that is behind
    const balance = await pub.readContract({ address: opts.token, abi: erc20, functionName: "balanceOf", args: [trader], blockNumber: receipt.blockNumber });
    out.push({ trader, txHash, balance });
  }
  return out;
}
