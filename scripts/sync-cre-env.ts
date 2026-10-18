// Copies DESK_PRIVATE_KEY from the root .env into workflows/.env as CRE_ETH_PRIVATE_KEY (the CRE CLI's signer).
// Never prints key material.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const root = readFileSync(new URL("../.env", import.meta.url), "utf8");
const desk = root.match(/^DESK_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)?.[1];
if (!desk) throw new Error("DESK_PRIVATE_KEY missing in .env — run scripts/gen-wallets.ts first");

const target = new URL("../workflows/.env", import.meta.url);
const current = readFileSync(target, "utf8");
const next = /^CRE_ETH_PRIVATE_KEY=.*$/m.test(current)
  ? current.replace(/^CRE_ETH_PRIVATE_KEY=.*$/m, `CRE_ETH_PRIVATE_KEY=${desk}`)
  : `${current.trimEnd()}\nCRE_ETH_PRIVATE_KEY=${desk}\n`;
writeFileSync(target, next);
chmodSync(target, 0o600);
console.log("workflows/.env: CRE_ETH_PRIVATE_KEY set from DESK_PRIVATE_KEY");
