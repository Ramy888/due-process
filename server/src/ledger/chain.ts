// Reads DeskLedger: what a Desk Writer transaction actually did (the contract records rejections as events instead
// of reverting, so a successful transaction is not a recorded trade), and live desk state that outlives a run.
import { createPublicClient, http, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { deskLedgerAbi } from "./abi.js";

export type LedgerEvent = { event: string; args: Record<string, unknown> };

export type LedgerReader = {
  events(txHash: Hex): Promise<LedgerEvent[]>;
  autoApproveActive(): Promise<boolean>;
  licenceActive(trader: Address): Promise<boolean>;
};

const LICENCE_ACTIVE = 1;
const DEFAULT_RPC: Record<number, string> = { 84532: "https://sepolia.base.org", 31337: "http://127.0.0.1:8545" };

export function ledgerReader(client: PublicClient, ledger: Address): LedgerReader {
  return {
    async events(txHash) {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      return parseEventLogs({ abi: deskLedgerAbi, logs: receipt.logs })
        .filter((l) => l.address.toLowerCase() === ledger.toLowerCase())
        .map((l) => ({ event: l.eventName, args: l.args as Record<string, unknown> }));
    },
    autoApproveActive: () => client.readContract({ address: ledger, abi: deskLedgerAbi, functionName: "autoApproveActive" }),
    async licenceActive(trader) {
      const l = await client.readContract({ address: ledger, abi: deskLedgerAbi, functionName: "licenceOf", args: [trader] });
      return l.status === LICENCE_ACTIVE;
    },
  };
}

export function readerFor(deployment: { chainId: number; deskLedger: Address }): LedgerReader {
  const url = process.env.LEDGER_RPC_URL ?? DEFAULT_RPC[deployment.chainId];
  if (!url) throw new Error(`no RPC for chain ${deployment.chainId}; set LEDGER_RPC_URL`);
  return ledgerReader(createPublicClient({ transport: http(url) }) as PublicClient, deployment.deskLedger);
}
