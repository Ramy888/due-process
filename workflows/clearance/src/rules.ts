// Pre-trade clearance rules. Pure functions with no runtime dependencies, so the CRE workflow (QuickJS/WASM) and the
// Node server share one implementation. Every hit carries a code a human can look up, and the worst hit sets the verdict.

export type Verdict = "CLEARED" | "FLAGGED" | "BLOCKED";
export type Severity = "info" | "flag" | "block";

/** On-chain verdict enum order in DeskLedger.sol (Cleared, Flagged, Blocked). */
export const VERDICT_CODE: Record<Verdict, number> = { CLEARED: 0, FLAGGED: 1, BLOCKED: 2 };

export type TokenRiskFindings = {
  chain: string;
  token: string;
  sources: string[];
  /** 0-100, higher is riskier (RugCheck score_normalised). */
  riskScore?: number;
  top10HolderPct?: number;
  lpLockedPct?: number;
  liquidityUsd?: number;
  mintAuthorityEnabled?: boolean;
  freezeAuthorityEnabled?: boolean;
  honeypot?: boolean;
  creatorRugHistory?: boolean;
  /** Addresses involved in the trade (deployer, creator, counterparties) that matched the OFAC list. */
  sanctionedMatches: string[];
  /** KOLs promoting the token who received it from the deployer before promoting it. */
  kolsFundedByDeployer: string[];
  /** KOLs promoting the token in the evidence window. */
  promotingKols: string[];
  /** Raw risk labels from the data providers, kept for the explanation. */
  providerRisks: { level: string; name: string }[];
};

export type RuleHit = { code: string; severity: Severity; detail: string };

export type ClearanceDecision = { verdict: Verdict; hits: RuleHit[] };

export const LIMITS = {
  concentrationFlagPct: 40,
  concentrationBlockPct: 60,
  lpLockedFlagPct: 50,
  lowLiquidityUsd: 50_000,
  /** Above this, liquidity is spread over many pools and one unlocked pool is not a rug signal. */
  deepLiquidityUsd: 1_000_000,
  maxShareOfLiquidity: 0.02,
  coordinatedShillMinKols: 3,
} as const;

export function emptyFindings(chain: string, token: string): TokenRiskFindings {
  return { chain, token, sources: [], sanctionedMatches: [], kolsFundedByDeployer: [], promotingKols: [], providerRisks: [] };
}

export function decide(f: TokenRiskFindings, notionalUsd: number): ClearanceDecision {
  const hits: RuleHit[] = [];
  const hit = (code: string, severity: Severity, detail: string) => hits.push({ code, severity, detail });

  if (f.sanctionedMatches.length > 0) {
    hit("SANCTIONS_MATCH", "block", `OFAC SDN match: ${f.sanctionedMatches.join(", ")}`);
  }
  if (f.honeypot) hit("HONEYPOT", "block", "Token can be bought but not sold");
  if (f.creatorRugHistory) hit("CREATOR_RUG_HISTORY", "block", "Creator has launched tokens that were rugged before");

  const funded = f.kolsFundedByDeployer.length;
  if (funded >= LIMITS.coordinatedShillMinKols) {
    hit(
      "COORDINATED_SHILL",
      "block",
      `${funded} of ${f.promotingKols.length} promoting KOLs received the token from its deployer before promoting it`,
    );
  } else if (funded > 0) {
    hit("UNDISCLOSED_PROMOTION", "flag", `${funded} promoting KOL(s) received the token from its deployer`);
  }

  const top10 = f.top10HolderPct;
  if (top10 !== undefined) {
    if (top10 > LIMITS.concentrationBlockPct) {
      hit("HOLDER_CONCENTRATION", "block", `Top-10 wallets hold ${top10.toFixed(1)}% of supply`);
    } else if (top10 > LIMITS.concentrationFlagPct) {
      hit("HOLDER_CONCENTRATION", "flag", `Top-10 wallets hold ${top10.toFixed(1)}% of supply`);
    }
  }

  if (f.mintAuthorityEnabled) {
    const concentrated = (top10 ?? 0) > LIMITS.concentrationFlagPct;
    hit(
      "MINT_AUTHORITY_ENABLED",
      concentrated ? "block" : "flag",
      concentrated ? "Creator can still mint new tokens and already holds a large share" : "Creator can still mint new tokens",
    );
  }
  if (f.freezeAuthorityEnabled) hit("FREEZE_AUTHORITY_ENABLED", "flag", "Creator can freeze holders' tokens");

  const lowLiquidity = f.liquidityUsd !== undefined && f.liquidityUsd < LIMITS.lowLiquidityUsd;
  const deepLiquidity = f.liquidityUsd !== undefined && f.liquidityUsd >= LIMITS.deepLiquidityUsd;
  if (f.lpLockedPct !== undefined && f.lpLockedPct < LIMITS.lpLockedFlagPct && !deepLiquidity) {
    hit(
      "LP_UNLOCKED",
      lowLiquidity ? "block" : "flag",
      `Only ${f.lpLockedPct.toFixed(1)}% of the liquidity pool is locked; the creator can withdraw the rest`,
    );
  }
  // no toLocaleString: QuickJS (the CRE runtime) has no Intl
  if (lowLiquidity) hit("LOW_LIQUIDITY", "flag", `Pool liquidity is $${Math.round(f.liquidityUsd!)}`);
  if (f.liquidityUsd !== undefined && f.liquidityUsd > 0 && notionalUsd > f.liquidityUsd * LIMITS.maxShareOfLiquidity) {
    hit("SIZE_VS_LIQUIDITY", "flag", `Trade is more than ${LIMITS.maxShareOfLiquidity * 100}% of pool liquidity`);
  }

  const verdict: Verdict = hits.some((h) => h.severity === "block")
    ? "BLOCKED"
    : hits.some((h) => h.severity === "flag")
      ? "FLAGGED"
      : "CLEARED";
  return { verdict, hits };
}

/** One-line reason stored on-chain next to the verdict. */
export function summarize(d: ClearanceDecision): string {
  if (d.hits.length === 0) return "CLEARED: no risk rule fired";
  return `${d.verdict}: ${d.hits.map((h) => h.code).join(", ")}`;
}

// ---------------------------------------------------------------------------------------------- normalizers
// Each takes a provider's JSON (already parsed) and merges what it knows into the findings.

type Json = Record<string, any>;

export function mergeRugCheckSummary(f: TokenRiskFindings, s: Json): TokenRiskFindings {
  const risks = (s.risks ?? []) as Json[];
  return {
    ...f,
    sources: [...f.sources, "rugcheck"],
    riskScore: num(s.score_normalised) ?? f.riskScore,
    lpLockedPct: num(s.lpLockedPct) ?? f.lpLockedPct,
    mintAuthorityEnabled: f.mintAuthorityEnabled || risks.some((r) => /mint authority/i.test(r.name)),
    freezeAuthorityEnabled: f.freezeAuthorityEnabled || risks.some((r) => /freeze authority/i.test(r.name)),
    creatorRugHistory: f.creatorRugHistory || risks.some((r) => /creator history of rugged/i.test(r.name)),
    providerRisks: [...f.providerRisks, ...risks.map((r) => ({ level: String(r.level), name: String(r.name) }))],
  };
}

export function mergeRugCheckReport(f: TokenRiskFindings, r: Json): TokenRiskFindings {
  const holders = ((r.topHolders ?? []) as Json[]).slice(0, 10);
  const top10 = holders.reduce((sum, h) => sum + (num(h.pct) ?? 0), 0);
  return {
    ...mergeRugCheckSummary(f, r),
    top10HolderPct: holders.length ? top10 : f.top10HolderPct,
    liquidityUsd: num(r.totalMarketLiquidity) ?? f.liquidityUsd,
    mintAuthorityEnabled: f.mintAuthorityEnabled || (r.mintAuthority != null && r.mintAuthority !== ""),
    freezeAuthorityEnabled: f.freezeAuthorityEnabled || (r.freezeAuthority != null && r.freezeAuthority !== ""),
  };
}

/** GoPlus EVM token_security result for one token (result[address]). */
export function mergeGoPlusEvm(f: TokenRiskFindings, g: Json): TokenRiskFindings {
  const holders = ((g.holders ?? []) as Json[]).slice(0, 10);
  const top10 = holders.reduce((sum, h) => sum + (num(h.percent) ?? 0) * 100, 0);
  const lpHolders = (g.lp_holders ?? []) as Json[];
  const locked = lpHolders.filter((h) => String(h.is_locked) === "1").reduce((s, h) => s + (num(h.percent) ?? 0) * 100, 0);
  return {
    ...f,
    sources: [...f.sources, "goplus"],
    honeypot: f.honeypot || g.is_honeypot === "1" || g.cannot_sell_all === "1",
    mintAuthorityEnabled: f.mintAuthorityEnabled || g.is_mintable === "1",
    top10HolderPct: holders.length ? top10 : f.top10HolderPct,
    lpLockedPct: lpHolders.length ? locked : f.lpLockedPct,
  };
}

/** DexScreener /latest/dex/tokens response; uses the deepest pair. */
export function mergeDexScreener(f: TokenRiskFindings, d: Json): TokenRiskFindings {
  const pairs = ((d.pairs ?? []) as Json[]).filter((p) => p?.liquidity?.usd != null);
  if (pairs.length === 0) return { ...f, sources: [...f.sources, "dexscreener"] };
  const liquidity = pairs.reduce((sum, p) => sum + (num(p.liquidity.usd) ?? 0), 0);
  return { ...f, sources: [...f.sources, "dexscreener"], liquidityUsd: liquidity };
}

/** OFAC SDN digital-currency address list (one address per line); matching is case-insensitive. */
export function sanctionedAmong(list: string, addresses: string[]): string[] {
  const set = new Set(
    list
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  return addresses.filter((a) => set.has(a.toLowerCase()));
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}
