import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROOT } from "../env.js";
import { deskLedgerAbi } from "./abi.js";

// Enum and struct names in the Solidity source map to their ABI types.
const SOLIDITY_TO_ABI: Record<string, string> = { Verdict: "uint8", Side: "uint8" };

describe("DeskLedger ABI used by the server", () => {
  it("declares every event exactly as the contract does (names, types, indexed)", () => {
    const src = readFileSync(`${ROOT}contracts/src/DeskLedger.sol`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const declared = new Map(
      [...src.matchAll(/event\s+(\w+)\(([^)]*)\);/g)].map(([, name, params]) => [
        name,
        params
          .split(",")
          .map((p) => p.trim().split(/\s+/))
          .filter((p) => p[0])
          .map(([type, maybeIndexed]) => `${SOLIDITY_TO_ABI[type] ?? type}${maybeIndexed === "indexed" ? " indexed" : ""}`),
      ]),
    );
    for (const item of deskLedgerAbi) {
      if (item.type !== "event") continue;
      const ours = item.inputs.map((i) => `${i.type}${"indexed" in i && i.indexed ? " indexed" : ""}`);
      expect({ event: item.name, params: declared.get(item.name) }).toEqual({ event: item.name, params: ours });
    }
  });
});
