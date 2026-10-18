// The licensed trader roster (data/traders.json): the same file the deploy script registers on-chain.
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, type Hex } from "viem";
import { ROOT } from "./env.js";

export type TraderKey = "TRADER_KOL" | "TRADER_WHALE" | "TRADER_NEWS" | "TRADER_MEME" | "TRADER_DIP";
export type TraderProfile = { key: TraderKey; name: string; watches: string; mandate: string };

const roster = JSON.parse(readFileSync(`${ROOT}data/traders.json`, "utf8")) as {
  traders: TraderProfile[];
  chief: { key: "CHIEF"; name: string; mandate: string };
};

export const traders: readonly TraderProfile[] = roster.traders;
export const chiefProfile = roster.chief;

/** What DeskLedger stores as the licence's mandateHash. */
export const mandateHash = (mandate: string): Hex => keccak256(stringToBytes(mandate));
