// Loads the root .env and, for the Anthropic key only, the file named by ANTHROPIC_ENV_FILE (never copied here).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const rootEnv = `${ROOT}.env`;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** Reads ANTHROPIC_API_KEY from ANTHROPIC_ENV_FILE at call time; the key never enters this repo's files. */
export function anthropicKey(): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    const file = required("ANTHROPIC_ENV_FILE");
    if (!existsSync(file)) throw new Error(`ANTHROPIC_ENV_FILE does not exist: ${file}`);
    process.loadEnvFile(file);
  }
  return required("ANTHROPIC_API_KEY");
}

export const PORT = Number(process.env.PORT ?? 8787);
