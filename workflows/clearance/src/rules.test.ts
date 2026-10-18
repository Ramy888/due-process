import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  decide,
  emptyFindings,
  mergeDexScreener,
  mergeRugCheckReport,
  mergeRugCheckSummary,
  sanctionedAmong,
  summarize,
  type TokenRiskFindings,
} from "./rules";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const base = (): TokenRiskFindings => emptyFindings("solana", "TOKEN");
const codes = (f: TokenRiskFindings, notional = 100) => decide(f, notional).hits.map((h) => h.code);

describe("real provider data", () => {
  test("BONK (deep liquidity, no authorities) clears", () => {
    let f = mergeRugCheckReport(base(), fixture("rugcheck-bonk-report.json"));
    f = mergeDexScreener(f, fixture("dexscreener-bonk.json"));
    const d = decide(f, 500);
    expect(f.mintAuthorityEnabled).toBe(false);
    expect(f.liquidityUsd!).toBeGreaterThan(50_000);
    expect(d.verdict).toBe("CLEARED");
  });

  test("token with unlocked LP is flagged", () => {
    const f = mergeRugCheckSummary(base(), fixture("rugcheck-lp-unlocked-summary.json"));
    expect(codes(f)).toContain("LP_UNLOCKED");
    expect(decide(f, 100).verdict).toBe("FLAGGED");
  });

  test("unlocked LP is ignored when liquidity is deep (many pools)", () => {
    const f = { ...mergeRugCheckSummary(base(), fixture("rugcheck-bonk-summary.json")), liquidityUsd: 1_372_000 };
    expect(f.lpLockedPct!).toBeLessThan(50);
    expect(decide(f, 500).verdict).toBe("CLEARED");
  });

  test("unlocked LP plus low liquidity is blocked", () => {
    const f = { ...mergeRugCheckSummary(base(), fixture("rugcheck-lp-unlocked-summary.json")), liquidityUsd: 9_000 };
    expect(decide(f, 100).verdict).toBe("BLOCKED");
  });

  test("creator with rug history is blocked", () => {
    const f = mergeRugCheckSummary(base(), fixture("rugcheck-rug-history-summary.json"));
    expect(codes(f)).toContain("CREATOR_RUG_HISTORY");
    expect(decide(f, 100).verdict).toBe("BLOCKED");
  });

  test("mint authority still enabled is at least flagged", () => {
    const f = mergeRugCheckSummary(base(), fixture("rugcheck-mint-authority-summary.json"));
    expect(codes(f)).toContain("MINT_AUTHORITY_ENABLED");
    expect(decide(f, 100).verdict).not.toBe("CLEARED");
  });
});

describe("rules", () => {
  test("no findings clears", () => {
    expect(decide(base(), 100)).toEqual({ verdict: "CLEARED", hits: [] });
    expect(summarize(decide(base(), 100))).toBe("CLEARED: no risk rule fired");
  });

  test("sanctions match blocks", () => {
    const list = readFileSync(new URL("../fixtures/ofac-eth.txt", import.meta.url), "utf8");
    const listed = list.split("\n")[0].trim();
    const matches = sanctionedAmong(list, ["0x000000000000000000000000000000000000dEaD", listed.toUpperCase()]);
    expect(matches).toEqual([listed.toUpperCase()]);
    expect(decide({ ...base(), sanctionedMatches: matches }, 100).verdict).toBe("BLOCKED");
  });

  test("three deployer-funded KOLs is a coordinated shill (blocked)", () => {
    const f = { ...base(), promotingKols: ["a", "b", "c", "d", "e", "f"], kolsFundedByDeployer: ["a", "b", "c", "d"] };
    const d = decide(f, 100);
    expect(d.verdict).toBe("BLOCKED");
    expect(d.hits[0].detail).toBe("4 of 6 promoting KOLs received the token from its deployer before promoting it");
  });

  test("one deployer-funded KOL is an undisclosed promotion (flagged)", () => {
    const f = { ...base(), promotingKols: ["a", "b"], kolsFundedByDeployer: ["a"] };
    expect(decide(f, 100).verdict).toBe("FLAGGED");
    expect(codes(f)).toEqual(["UNDISCLOSED_PROMOTION"]);
  });

  test("concentration thresholds", () => {
    expect(decide({ ...base(), top10HolderPct: 40 }, 100).verdict).toBe("CLEARED");
    expect(decide({ ...base(), top10HolderPct: 41 }, 100).verdict).toBe("FLAGGED");
    expect(decide({ ...base(), top10HolderPct: 61 }, 100).verdict).toBe("BLOCKED");
  });

  test("mint authority with concentration blocks", () => {
    expect(decide({ ...base(), mintAuthorityEnabled: true, top10HolderPct: 45 }, 100).verdict).toBe("BLOCKED");
  });

  test("trade too large for the pool is flagged", () => {
    expect(codes({ ...base(), liquidityUsd: 100_000 }, 2_001)).toEqual(["SIZE_VS_LIQUIDITY"]);
    expect(codes({ ...base(), liquidityUsd: 100_000 }, 2_000)).toEqual([]);
  });

  test("honeypot blocks", () => {
    expect(decide({ ...base(), honeypot: true }, 100).verdict).toBe("BLOCKED");
  });

  test("summary lists rule codes", () => {
    const d = decide({ ...base(), honeypot: true, top10HolderPct: 45 }, 100);
    expect(summarize(d)).toBe("BLOCKED: HONEYPOT, HOLDER_CONCENTRATION");
  });
});
