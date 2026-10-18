// EIP-712 messages DeskLedger verifies: the Chief signs trades and refusals, the human signs large trades and
// judgments. Domain and type strings must match DeskLedger.sol exactly (EIP712("DueProcessDesk", "1")).
import { hashTypedData, keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

export const deskDomain = (chainId: number, deskLedger: Address) =>
  ({ name: "DueProcessDesk", version: "1", chainId, verifyingContract: deskLedger }) as const;

export const deskTypes = {
  Trade: [
    { name: "clearanceId", type: "bytes32" },
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "side", type: "uint8" },
    { name: "notional", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "trailHash", type: "bytes32" },
  ],
  Refusal: [
    { name: "clearanceId", type: "bytes32" },
    { name: "trader", type: "address" },
    { name: "reasonHash", type: "bytes32" },
    { name: "trailHash", type: "bytes32" },
  ],
  Judgment: [
    { name: "caseId", type: "bytes32" },
    { name: "defendant", type: "address" },
    { name: "sanctions", type: "uint8" },
    { name: "slashAmount", type: "uint256" },
    { name: "caseHash", type: "bytes32" },
  ],
} as const;

export type TradeMessage = { clearanceId: Hex; trader: Address; token: Address; side: 0 | 1; notional: bigint; nonce: bigint; trailHash: Hex };
export type RefusalMessage = { clearanceId: Hex; trader: Address; reasonHash: Hex; trailHash: Hex };
export type JudgmentMessage = { caseId: Hex; defendant: Address; sanctions: number; slashAmount: bigint; caseHash: Hex };

type Domain = ReturnType<typeof deskDomain>;

export const tradeDigest = (domain: Domain, message: TradeMessage) =>
  hashTypedData({ domain, types: deskTypes, primaryType: "Trade", message });
export const refusalDigest = (domain: Domain, message: RefusalMessage) =>
  hashTypedData({ domain, types: deskTypes, primaryType: "Refusal", message });
export const judgmentDigest = (domain: Domain, message: JudgmentMessage) =>
  hashTypedData({ domain, types: deskTypes, primaryType: "Judgment", message });

export const signTrade = (signer: LocalAccount, domain: Domain, message: TradeMessage) =>
  signer.signTypedData({ domain, types: deskTypes, primaryType: "Trade", message });
export const signRefusal = (signer: LocalAccount, domain: Domain, message: RefusalMessage) =>
  signer.signTypedData({ domain, types: deskTypes, primaryType: "Refusal", message });
export const signJudgment = (signer: LocalAccount, domain: Domain, message: JudgmentMessage) =>
  signer.signTypedData({ domain, types: deskTypes, primaryType: "Judgment", message });

export const reasonHash = (reason: string): Hex => keccak256(stringToBytes(reason));
