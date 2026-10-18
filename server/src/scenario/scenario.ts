// Scenario files (data/scenario/*.json): synthetic feed items, a frozen market snapshot and the beats to play.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ROOT } from "../env.js";

const feedItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("post"), handle: z.string(), minute: z.number(), text: z.string() }),
  z.object({ kind: z.literal("news"), source: z.string(), minute: z.number(), text: z.string() }),
  z.object({ kind: z.literal("market"), minute: z.number(), text: z.string() }),
]);
export type FeedItem = z.infer<typeof feedItem>;

const token = z.object({
  chain: z.enum(["solana", "base-sepolia"]),
  /** A mint/contract address, or "deployment:<key>" for a token this project deploys (resolved per network). */
  address: z.string(),
  priceUsd: z.number().positive(),
  liquidityUsd: z.number().nonnegative(),
  change24hPct: z.number(),
  staged: z.boolean().optional(),
});
export type ScenarioToken = z.infer<typeof token>;

const traderKey = z.enum(["TRADER_KOL", "TRADER_WHALE", "TRADER_NEWS", "TRADER_MEME", "TRADER_DIP"]);

const beat = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  trader: traderKey,
  candidates: z.array(z.string()).min(1),
  feed: z.array(feedItem),
  /** The beat's trader sells a signal to other agents over x402 before trading. */
  signalSale: z.object({ symbol: z.string(), text: z.string(), buyers: z.array(traderKey).min(1) }).optional(),
  /** Scripted orders instead of a model decision: misconduct the desk must catch, labelled as staged in the UI. */
  staged: z
    .object({
      label: z.string(),
      orders: z.array(z.object({ symbol: z.string(), side: z.enum(["buy", "sell"]), notionalUsd: z.number().positive(), note: z.string() })).min(1),
    })
    .optional(),
});
export type Beat = z.infer<typeof beat>;

const scenarioSchema = z
  .object({ id: z.string(), title: z.string(), snapshotLabel: z.string(), tokens: z.record(token), beats: z.array(beat) })
  .passthrough()
  .superRefine((s, ctx) => {
    for (const b of s.beats) {
      for (const c of b.candidates)
        if (!s.tokens[c]) ctx.addIssue({ code: "custom", message: `beat ${b.id}: unknown token ${c}` });
      for (const o of b.staged?.orders ?? [])
        if (!b.candidates.includes(o.symbol)) ctx.addIssue({ code: "custom", message: `beat ${b.id}: staged order for non-candidate ${o.symbol}` });
    }
  });
export type Scenario = z.infer<typeof scenarioSchema>;

export const loadScenario = (id: string): Scenario =>
  scenarioSchema.parse(JSON.parse(readFileSync(`${ROOT}data/scenario/${id}.json`, "utf8")));

/** Addresses of contracts this project deployed, from deployments/<DEPLOYMENT>.json (default base-sepolia). */
export function deploymentAddress(key: string, deployment = process.env.DEPLOYMENT ?? "base-sepolia"): string {
  const file = `${ROOT}deployments/${deployment}.json`;
  if (!existsSync(file)) throw new Error(`no ${deployment} deployment yet (${file}); deploy DeskLedger and $FROG first`);
  const value = JSON.parse(readFileSync(file, "utf8"))[key];
  if (typeof value !== "string") throw new Error(`deployments/${deployment}.json has no ${key}`);
  return value;
}

export const tokenAddress = (t: ScenarioToken, resolve = deploymentAddress): string =>
  t.address.startsWith("deployment:") ? resolve(t.address.slice("deployment:".length)) : t.address;

/** Which personas pushed this token in the beat's feed (by $SYMBOL mention). */
export const promotersOf = (b: Beat, symbol: string): string[] =>
  b.feed.filter((f): f is Extract<FeedItem, { kind: "post" }> => f.kind === "post" && f.text.includes(`$${symbol}`)).map((p) => p.handle);
