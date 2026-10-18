// Private evidence bundles the clearance workflow fetches through Chainlink Confidential HTTP.
// They hold the desk's KOL watchlist and wallets, which must not appear in workflow config, logs or on-chain.
import type { Address } from "viem";

export type Evidence = {
  promotingKols: { handle: string; wallet: string }[];
  deployer?: string;
  counterparties: string[];
};

const store = new Map<string, Evidence>();

export const putEvidence = (id: string, e: Evidence) => void store.set(id, e);
export const getEvidence = (id: string) => store.get(id);
export const evidenceFor = (promoting: { handle: string; wallet: Address }[], deployer?: Address): Evidence => ({
  promotingKols: promoting.map((p) => ({ handle: p.handle, wallet: p.wallet })),
  deployer,
  counterparties: [],
});
