// Loads the root .env and, for the Anthropic key only, the file named by ANTHROPIC_ENV_FILE (never copied here).
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const rootEnv = `${ROOT}.env`;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** Reads only ANTHROPIC_API_KEY from ANTHROPIC_ENV_FILE. It is returned, never put in process.env, so child
 *  processes (the CRE CLI) and this repo's files never see it or anything else in that file. */
export function anthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const file = required("ANTHROPIC_ENV_FILE");
  if (!existsSync(file)) throw new Error(`ANTHROPIC_ENV_FILE does not exist: ${file}`);
  const key = parseEnv(readFileSync(file, "utf8")).ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in ANTHROPIC_ENV_FILE");
  return key;
}

export const PORT = Number(process.env.PORT ?? 8787);
