// The DeskLedger surface the server reads. Kept in step with contracts/src/DeskLedger.sol by abi.test.ts.
import { parseAbi } from "viem";

export const deskLedgerAbi = parseAbi([
  "event ClearanceRecorded(bytes32 indexed clearanceId, address indexed trader, address token, uint256 notional, uint8 verdict, bytes32 findingsHash, string reason)",
  "event TradeRecorded(bytes32 indexed tradeId, bytes32 indexed clearanceId, address indexed trader, address token, uint8 side, uint256 notional, bool autoApproved, bytes32 trailHash)",
  "event TradeRejected(bytes32 indexed tradeId, bytes32 indexed clearanceId, address indexed trader, string reason)",
  "event TradeRefused(bytes32 indexed clearanceId, address indexed trader, string reason, bytes32 trailHash)",
  "event RefusalRejected(bytes32 indexed clearanceId, address indexed trader, string reason)",
  "event JudgmentRecorded(bytes32 indexed caseId, address indexed defendant, uint8 sanctions, uint256 slashed, bytes32 caseHash)",
  "event JudgmentRejected(bytes32 indexed caseId, address indexed defendant, string reason)",
  "function autoApproveActive() view returns (bool)",
  "function licenceOf(address trader) view returns ((uint8 status, bytes32 mandateHash, uint256 bond, uint256 allocation, uint256 spent, string name))",
  "function licensees() view returns (address[])",
]);
