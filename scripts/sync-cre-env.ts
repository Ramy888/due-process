// Prepares the CRE CLI environment (workflows/.env) from the root .env without printing secrets:
//   CRE_ETH_PRIVATE_KEY  <- DESK_PRIVATE_KEY (signer for simulate --broadcast)
//   DESK_API_TOKEN_VAR   <- DESK_API_TOKEN   (Confidential HTTP bearer token for the desk evidence API)
// DESK_API_TOKEN is generated into the root .env on first run.
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

const rootPath = new URL("../.env", import.meta.url);
let root = readFileSync(rootPath, "utf8");
if (!/^DESK_API_TOKEN=/m.test(root)) {
  appendFileSync(rootPath, `DESK_API_TOKEN=${randomBytes(32).toString("hex")}\n`);
  root = readFileSync(rootPath, "utf8");
}
const get = (name: string) => {
  const v = root.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  if (!v) throw new Error(`${name} missing in .env`);
  return v.trim();
};

const targetPath = new URL("../workflows/.env", import.meta.url);
let target = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
const set = (name: string, value: string) => {
  const line = `${name}=${value}`;
  target = new RegExp(`^${name}=.*$`, "m").test(target)
    ? target.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : `${target.trimEnd()}\n${line}\n`;
};
set("CRE_ETH_PRIVATE_KEY", get("DESK_PRIVATE_KEY"));
set("DESK_API_TOKEN_VAR", get("DESK_API_TOKEN"));
writeFileSync(targetPath, target);
chmodSync(targetPath, 0o600);
console.log("workflows/.env: CRE_ETH_PRIVATE_KEY and DESK_API_TOKEN_VAR set");
