import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, getAddress, type Address } from "viem";
import { ROOT } from "./env.js";

export type Persona = { handle: string; name: string; followers: number; style: string; wallet: Address };

/** Deterministic wallet for a simulated persona: last 20 bytes of keccak256("due-process:persona:<handle>"). */
export const personaWallet = (handle: string): Address =>
  getAddress(`0x${keccak256(stringToBytes(`due-process:persona:${handle}`)).slice(-40)}`);

export const personas: Persona[] = (
  JSON.parse(readFileSync(`${ROOT}data/personas.json`, "utf8")).kols as Omit<Persona, "wallet">[]
).map((p) => ({ ...p, wallet: personaWallet(p.handle) }));
