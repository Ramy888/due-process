import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROOT } from "./env.js";
import { DESK, DeskBook } from "./desk.js";

describe("desk parameters", () => {
  it("match the constants the deploy script puts on-chain", () => {
    // strip comments so a commented-out value can never satisfy the check
    const src = readFileSync(`${ROOT}contracts/script/Deploy.s.sol`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const usd = (name: string) => {
      const m = src.match(new RegExp(`uint256 constant ${name} = ([\\d_]+)e6;`));
      if (!m) throw new Error(`${name} not found in Deploy.s.sol`);
      return Number(m[1].replaceAll("_", ""));
    };
    expect({
      budgetUsd: usd("DESK_BUDGET"),
      allocationUsd: usd("ALLOCATION"),
      autoApproveUsd: usd("AUTO_APPROVE"),
      coSignUsd: usd("CO_SIGN"),
      maxTradeUsd: usd("MAX_TRADE"),
    }).toEqual(DESK);
  });
});

describe("desk book", () => {
  it("tracks positions and spend per trader", () => {
    const book = new DeskBook();
    book.record("TRADER_NEWS", "WIF", "buy", 200);
    book.record("TRADER_NEWS", "WIF", "buy", 50);
    book.record("TRADER_NEWS", "WIF", "sell", 250);
    book.record("TRADER_DIP", "WIF", "buy", 150);
    expect(book.holdingsUsd("TRADER_NEWS")).toEqual({});
    expect(book.spentUsd("TRADER_NEWS")).toBe(0);
    expect(book.all()).toEqual({ TRADER_NEWS: {}, TRADER_DIP: { WIF: 150 } });
  });
});
