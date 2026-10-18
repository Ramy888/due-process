// Builds TokenRiskFindings from raw provider responses. Pure and deterministic (values are rounded) so every DON
// node reaches the same observation for identical-consensus.
import {
  emptyFindings,
  mergeDexScreener,
  mergeRugCheckSummary,
  sanctionedAmong,
  type TokenRiskFindings,
} from "./rules";

/** Private evidence bundle served by the desk API through Confidential HTTP. */
export type Evidence = {
  promotingKols: { handle: string; wallet: string }[];
  deployer?: string;
  counterparties: string[];
};

type Json = Record<string, any>;

const round1 = (n: number) => Math.round(n * 10) / 10;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/** Solana (or any RugCheck-covered) token: RugCheck summary + DexScreener liquidity + OFAC SOL list. */
export function solanaFindings(
  token: string,
  rugcheckSummary: Json,
  dexscreener: Json,
  ofacSolList: string,
  evidence: Evidence,
): TokenRiskFindings {
  let f = mergeRugCheckSummary(emptyFindings("solana", token), rugcheckSummary);
  f = mergeDexScreener(f, dexscreener);
  // The summary has no holder list, only RugCheck's risk labels: "Top 10 holders high ownership" means the top 10 hold
  // more than 70%; "Single holder ownership" carries one wallet's share, a lower bound for the top 10.
  const risks = (rugcheckSummary.risks ?? []) as Json[];
  const singles = risks.filter((r) => /single holder ownership/i.test(r.name)).map((r) => parseFloat(String(r.value)));
  if (risks.some((r) => /top 10 holders high ownership/i.test(r.name))) f = { ...f, top10HolderPct: 70 };
  else if (singles.some((x) => Number.isFinite(x))) f = { ...f, top10HolderPct: Math.max(...singles.filter(Number.isFinite)) };
  else if (risks.some((r) => /high holder concentration/i.test(r.name))) f = { ...f, top10HolderPct: 50 };
  return finish(f, evidence, ofacSolList, []);
}

/**
 * EVM token on a chain with a Blockscout explorer (our Base Sepolia demo token): concentration from the holder list,
 * deployer→KOL transfers from the token's transfer history, mint flag from an EVM read done in DON mode.
 */
export function evmFindings(
  chain: string,
  token: string,
  tokenInfo: Json,
  holders: Json,
  transfers: Json,
  ofacEthList: string,
  evidence: Evidence,
  mintingEnabled: boolean,
): TokenRiskFindings {
  const supply = Number(tokenInfo.total_supply ?? 0);
  const top = ((holders.items ?? []) as Json[]).slice(0, 10);
  const top10 = supply > 0 ? top.reduce((s, h) => s + Number(h.value ?? 0), 0) / supply * 100 : undefined;

  const deployer = evidence.deployer?.toLowerCase();
  const fundedWallets = new Set(
    ((transfers.items ?? []) as Json[])
      .filter((t) => deployer && String(t.from?.hash ?? "").toLowerCase() === deployer)
      .map((t) => String(t.to?.hash ?? "").toLowerCase()),
  );
  const funded = evidence.promotingKols.filter((k) => fundedWallets.has(k.wallet.toLowerCase())).map((k) => k.handle);

  const f: TokenRiskFindings = {
    ...emptyFindings(chain, token),
    sources: ["evm-read", "blockscout"],
    top10HolderPct: top10 === undefined ? undefined : round1(top10),
    mintAuthorityEnabled: mintingEnabled,
  };
  return finish(f, evidence, ofacEthList, funded);
}

function finish(f: TokenRiskFindings, evidence: Evidence, ofacList: string, funded: string[]): TokenRiskFindings {
  const involved = [evidence.deployer, ...evidence.counterparties, ...evidence.promotingKols.map((k) => k.wallet)].filter(
    (a): a is string => Boolean(a),
  );
  return {
    ...f,
    sources: [...f.sources, "ofac-sdn"],
    liquidityUsd: f.liquidityUsd === undefined ? undefined : roundTo(f.liquidityUsd, 1000),
    lpLockedPct: f.lpLockedPct === undefined ? undefined : round1(f.lpLockedPct),
    sanctionedMatches: sanctionedAmong(ofacList, involved),
    promotingKols: evidence.promotingKols.map((k) => k.handle),
    kolsFundedByDeployer: funded,
  };
}
