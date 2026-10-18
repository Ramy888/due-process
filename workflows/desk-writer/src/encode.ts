// Desk Writer request shapes and their ABI encoding for DeskLedger._processReport (Action enum order:
// Clearance=0, Trade=1, Judgment=2, Refusal=3).
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const signature = z.string().regex(/^0x([0-9a-fA-F]{130})?$/); // 65-byte ECDSA signature, or "0x" when not required

export const requestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("trade"),
    trade: z.object({
      clearanceId: bytes32,
      trader: address,
      token: address,
      side: z.union([z.literal(0), z.literal(1)]),
      notionalE6: uint,
      nonce: uint,
      trailHash: bytes32,
    }),
    chiefSig: signature,
    humanSig: signature,
  }),
  z.object({
    kind: z.literal("judgment"),
    judgment: z.object({
      caseId: bytes32,
      defendant: address,
      sanctions: z.number().int().min(0).max(7),
      slashAmountE6: uint,
      caseHash: bytes32,
    }),
    humanSig: signature,
  }),
  z.object({
    kind: z.literal("refusal"),
    refusal: z.object({ clearanceId: bytes32, trader: address, trailHash: bytes32 }),
    /** Stored on-chain in full; the Chief signs its keccak256. */
    reason: z.string().min(1).max(500),
    chiefSig: signature,
  }),
]);
export type DeskRequest = z.infer<typeof requestSchema>;

const ACTION_TRADE = 1;
const ACTION_JUDGMENT = 2;
const ACTION_REFUSAL = 3;

export function encodeRequest(req: DeskRequest): { action: number; body: Hex; label: string } {
  if (req.kind === "refusal") {
    const r = req.refusal;
    const body = encodeAbiParameters(parseAbiParameters("(bytes32,address,bytes32,bytes32), string, bytes"), [
      [r.clearanceId as Hex, r.trader as Address, keccak256(stringToBytes(req.reason)), r.trailHash as Hex],
      req.reason,
      req.chiefSig as Hex,
    ]);
    return { action: ACTION_REFUSAL, body, label: `REFUSAL ${r.clearanceId.slice(0, 10)} for ${r.trader}` };
  }
  if (req.kind === "trade") {
    const t = req.trade;
    const body = encodeAbiParameters(
      parseAbiParameters("(bytes32,address,address,uint8,uint256,uint256,bytes32), bytes, bytes"),
      [
        [t.clearanceId as Hex, t.trader as Address, t.token as Address, t.side, BigInt(t.notionalE6), BigInt(t.nonce), t.trailHash as Hex],
        req.chiefSig as Hex,
        req.humanSig as Hex,
      ],
    );
    return { action: ACTION_TRADE, body, label: `TRADE ${t.trader} ${t.side === 0 ? "BUY" : "SELL"} ${t.notionalE6}` };
  }
  const j = req.judgment;
  const body = encodeAbiParameters(parseAbiParameters("(bytes32,address,uint8,uint256,bytes32), bytes"), [
    [j.caseId as Hex, j.defendant as Address, j.sanctions, BigInt(j.slashAmountE6), j.caseHash as Hex],
    req.humanSig as Hex,
  ]);
  return { action: ACTION_JUDGMENT, body, label: `JUDGMENT ${j.caseId.slice(0, 10)} against ${j.defendant}` };
}
