// Due Process — Desk Writer workflow.
// HTTP trigger with a Chief-approved trade or a human-approved judgment → ABI-encoded TRADE / JUDGMENT report →
// DeskLedger on Base Sepolia. The contract re-checks every signature and rule; this workflow only shapes the report.
import {
  EVMClient,
  HTTPCapability,
  Runner,
  TxStatus,
  bytesToHex,
  decodeJson,
  getNetwork,
  handler,
  prepareReportRequest,
  type HTTPPayload,
  type Runtime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { z } from "zod";

const sharedConfig = {
  chainSelectorName: z.string(),
  gasLimit: z.string().regex(/^\d+$/),
  authorizedKeys: z.array(z.object({ type: z.literal("KEY_TYPE_ECDSA_EVM"), publicKey: z.string() })),
};
// local-simulation: validates and encodes the report, then stops before building it (no receiver needed).
const configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-simulation"), ...sharedConfig }).strict(),
  z.object({ mode: z.literal("ledger"), deskLedger: z.string().regex(/^0x[0-9a-fA-F]{40}$/), ...sharedConfig }).strict(),
]);
type Config = z.infer<typeof configSchema>;

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const signature = z.string().regex(/^0x([0-9a-fA-F]{130})?$/); // 65-byte ECDSA signature, or "0x" when not required

const requestSchema = z.discriminatedUnion("kind", [
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
]);
type DeskRequest = z.infer<typeof requestSchema>;

const ACTION_TRADE = 1;
const ACTION_JUDGMENT = 2;

function encodeRequest(req: DeskRequest): { action: number; body: Hex; label: string } {
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

export const onDeskRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const req = requestSchema.parse(decodeJson(payload.input));
  const { action, body, label } = encodeRequest(req);
  const encoded = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [action, body]);
  runtime.log(label);

  if (runtime.config.mode === "local-simulation") {
    runtime.log("local-simulation: report payload encoded; no report built, nothing written");
    return JSON.stringify({ kind: req.kind, mode: "local-simulation", payloadBytes: (encoded.length - 2) / 2, txHash: null });
  }

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!network) throw new Error(`Unknown selector: ${runtime.config.chainSelectorName}`);
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const result = new EVMClient(network.chainSelector.selector)
    .writeReport(runtime, { receiver: runtime.config.deskLedger, report, gasConfig: { gasLimit: runtime.config.gasLimit } })
    .result();
  if (result.txStatus !== TxStatus.SUCCESS) throw new Error(result.errorMessage ?? `write status ${result.txStatus}`);
  const txHash = result.txHash && result.txHash.length > 0 ? bytesToHex(result.txHash) : null;
  runtime.log(txHash ? `${req.kind.toUpperCase()} written: ${txHash}` : "report built; dry run, nothing broadcast");
  return JSON.stringify({ kind: req.kind, mode: "ledger", txHash });
};

export const initWorkflow = (config: Config) => [
  handler(new HTTPCapability().trigger({ authorizedKeys: config.authorizedKeys }), onDeskRequest),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
