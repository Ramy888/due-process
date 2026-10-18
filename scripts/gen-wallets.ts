// Generates testnet-only wallets into .env (never prints private keys). Skips roles that already exist.
import { existsSync, readFileSync, appendFileSync, chmodSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROLES = ["DESK", "CHIEF", "HUMAN_APPROVER", "TRADER_KOL", "TRADER_WHALE", "TRADER_NEWS", "TRADER_MEME", "TRADER_DIP"];
const envPath = new URL("../.env", import.meta.url);
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

let added = "";
for (const role of ROLES) {
  const key = `${role}_PRIVATE_KEY`;
  if (current.includes(`${key}=`)) continue;
  added += `${key}=${generatePrivateKey()}\n`;
}
if (!current.includes("CRE_ETH_PRIVATE_KEY=") && !current.includes("DESK_PRIVATE_KEY=")) {
  added += "# CRE CLI signs simulate --broadcast txs with this (same as the desk wallet)\n";
}
if (added) appendFileSync(envPath, added);
chmodSync(envPath, 0o600);

const all = readFileSync(envPath, "utf8");
for (const role of ROLES) {
  const m = all.match(new RegExp(`^${role}_PRIVATE_KEY=(0x[0-9a-f]{64})$`, "m"));
  if (m) console.log(role.padEnd(15), privateKeyToAccount(m[1] as `0x${string}`).address);
}
