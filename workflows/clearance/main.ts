// Due Process — Pre-Trade Clearance workflow.
// HTTP trigger (called by the x402 gateway after the trader agent pays) → private evidence via Confidential HTTP →
// token risk data (RugCheck, DexScreener, Blockscout, OFAC SDN) in node mode with identical consensus → EVM read of
// the token's mint flag → rule verdict → CLEARANCE report written to DeskLedger on Base Sepolia.
import {
  ConfidentialHTTPClient,
  EVMClient,
  HTTPCapability,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  handler,
  json,
  ok,
  prepareReportRequest,
  text,
  type HTTPPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { evmFindings, solanaFindings, type Evidence } from "./src/findings";
import { VERDICT_CODE, decide, summarize, type TokenRiskFindings } from "./src/rules";

// z.string().url() needs the URL global, which QuickJS lacks
const httpUrl = z.string().regex(/^https?:\/\/[^\s]+$/);
const sharedConfig = {
  chainSelectorName: z.string(),
  gasLimit: z.string().regex(/^\d+$/),
  deskApiUrl: httpUrl,
  secretOwner: z.string(),
  rugcheckUrl: httpUrl,
  dexscreenerUrl: httpUrl,
  blockscoutUrl: httpUrl,
  ofacEthUrl: httpUrl,
  ofacSolUrl: httpUrl,
  authorizedKeys: z.array(z.object({ type: z.literal("KEY_TYPE_ECDSA_EVM"), publicKey: z.string() })),
};
// local-simulation: runs every real fetch and the verdict, then stops before building a report (no receiver needed).
const configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-simulation"), ...sharedConfig }).strict(),
  z.object({ mode: z.literal("ledger"), deskLedger: z.string().regex(/^0x[0-9a-fA-F]{40}$/), ...sharedConfig }).strict(),
]);
type Config = z.infer<typeof configSchema>;

const requestSchema = z.object({
  clearanceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  trader: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain: z.enum(["solana", "base-sepolia"]),
  token: z.string().min(1),
  /** Address the ledger uses for the token (the ERC-20 itself on EVM; a derived id for Solana mints). */
  ledgerToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  notionalE6: z.string().regex(/^\d+$/),
  evidenceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
type ClearanceRequest = z.infer<typeof requestSchema>;

const evidenceSchema = z.object({
  promotingKols: z.array(z.object({ handle: z.string(), wallet: z.string() })),
  deployer: z.string().optional(),
  counterparties: z.array(z.string()),
});

const tokenAbi = parseAbi(["function mintingEnabled() view returns (bool)", "function owner() view returns (address)"]);

/** Private evidence (KOL watchlist + wallets) stays out of workflow config and logs: Confidential HTTP + Vault secret. */
function fetchEvidence(runtime: Runtime<Config>, evidenceId: string): Evidence {
  const response = new ConfidentialHTTPClient()
    .sendRequest(runtime, {
      request: {
        url: `${runtime.config.deskApiUrl}/evidence/${evidenceId}`,
        method: "GET",
        multiHeaders: { Authorization: { values: ["Bearer {{.DESK_API_TOKEN}}"] } },
      },
      vaultDonSecrets: [{ key: "DESK_API_TOKEN", owner: runtime.config.secretOwner }],
    })
    .result();
  if (!ok(response)) throw new Error(`evidence request failed: HTTP ${response.statusCode}`);
  return evidenceSchema.parse(json(response));
}

function readMintingEnabled(runtime: Runtime<Config>, token: Address): boolean {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!network) throw new Error(`Unknown selector: ${runtime.config.chainSelectorName}`);
  const client = new EVMClient(network.chainSelector.selector);
  const call = (functionName: "mintingEnabled" | "owner") =>
    client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: token, data: encodeFunctionData({ abi: tokenAbi, functionName }) }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
  const enabled = decodeFunctionResult({ abi: tokenAbi, functionName: "mintingEnabled", data: bytesToHex(call("mintingEnabled").data) });
  const owner = decodeFunctionResult({ abi: tokenAbi, functionName: "owner", data: bytesToHex(call("owner").data) });
  return enabled && owner !== zeroAddress;
}

/** Runs on every node; returns a compact JSON observation for identical consensus. */
function gatherFindings(node: NodeRuntime<Config>, requestJson: string, evidenceJson: string, mintingEnabled: boolean): string {
  const req = JSON.parse(requestJson) as ClearanceRequest;
  const evidence = JSON.parse(evidenceJson) as Evidence;
  const http = new HTTPClient();
  const get = (url: string) => {
    const response = http.sendRequest(node, { url, method: "GET", cacheSettings: { store: false } }).result();
    if (!ok(response)) throw new Error(`GET ${url} failed: HTTP ${response.statusCode}`);
    return response;
  };

  let findings: TokenRiskFindings;
  if (req.chain === "solana") {
    findings = solanaFindings(
      req.token,
      json(get(`${node.config.rugcheckUrl}/v1/tokens/${req.token}/report/summary`)) as Record<string, any>,
      json(get(`${node.config.dexscreenerUrl}/latest/dex/tokens/${req.token}`)) as Record<string, any>,
      text(get(node.config.ofacSolUrl)),
      evidence,
    );
  } else {
    const base = `${node.config.blockscoutUrl}/api/v2/tokens/${req.token}`;
    findings = evmFindings(
      req.chain,
      req.token,
      json(get(base)) as Record<string, any>,
      json(get(`${base}/holders`)) as Record<string, any>,
      json(get(`${base}/transfers`)) as Record<string, any>,
      text(get(node.config.ofacEthUrl)),
      evidence,
      mintingEnabled,
    );
  }
  return JSON.stringify(findings);
}

function writeClearance(
  runtime: Runtime<Config>,
  deskLedger: string,
  req: ClearanceRequest,
  verdictCode: number,
  findingsHash: Hex,
  reason: string,
) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!network) throw new Error(`Unknown selector: ${runtime.config.chainSelectorName}`);
  const body = encodeAbiParameters(parseAbiParameters("bytes32, address, address, uint256, uint8, bytes32, string"), [
    req.clearanceId as Hex,
    req.trader as Address,
    req.ledgerToken as Address,
    BigInt(req.notionalE6),
    verdictCode,
    findingsHash,
    reason,
  ]);
  const encoded = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [0, body]); // Action.Clearance = 0
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const result = new EVMClient(network.chainSelector.selector)
    .writeReport(runtime, { receiver: deskLedger, report, gasConfig: { gasLimit: runtime.config.gasLimit } })
    .result();
  if (result.txStatus !== TxStatus.SUCCESS) throw new Error(result.errorMessage ?? `write status ${result.txStatus}`);
  const txHash = result.txHash && result.txHash.length > 0 ? bytesToHex(result.txHash) : null;
  // A dry-run simulation (no --broadcast) sends nothing, so there is no hash; never invent one.
  runtime.log(txHash ? `CLEARANCE written: ${txHash}` : "CLEARANCE report built; dry run, nothing broadcast");
  return txHash;
}

export const onClearanceRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const req = requestSchema.parse(decodeJson(payload.input));
  runtime.log(`clearance ${req.clearanceId.slice(0, 10)} trader ${req.trader} ${req.chain}:${req.token}`);

  const evidence = fetchEvidence(runtime, req.evidenceId);
  const mintingEnabled = req.chain === "base-sepolia" ? readMintingEnabled(runtime, req.token as Address) : false;

  const findingsJson = runtime
    .runInNodeMode(gatherFindings, consensusIdenticalAggregation<string>())(
      JSON.stringify(req),
      JSON.stringify(evidence),
      mintingEnabled,
    )
    .result();
  const findings = JSON.parse(findingsJson) as TokenRiskFindings;
  const notionalUsd = Number(BigInt(req.notionalE6) / 10_000n) / 100;
  const decision = decide(findings, notionalUsd);
  const reason = summarize(decision);
  runtime.log(reason.slice(0, 900));

  const findingsHash = keccak256(stringToBytes(findingsJson));
  const result = { clearanceId: req.clearanceId, verdict: decision.verdict, hits: decision.hits, findings, findingsHash };
  if (runtime.config.mode === "local-simulation") {
    runtime.log("local-simulation: verdict computed; no report built, nothing written");
    return JSON.stringify({ ...result, mode: "local-simulation", txHash: null });
  }
  const txHash = writeClearance(runtime, runtime.config.deskLedger, req, VERDICT_CODE[decision.verdict], findingsHash, reason);
  return JSON.stringify({ ...result, mode: "ledger", txHash });
};

export const initWorkflow = (config: Config) => [
  handler(new HTTPCapability().trigger({ authorizedKeys: config.authorizedKeys }), onClearanceRequest),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
