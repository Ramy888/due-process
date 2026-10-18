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
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { encodeRequest, requestSchema } from "./src/encode";
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
