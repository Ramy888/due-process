// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {PolicyProtectedBase} from "@chainlink/policy-management/core/PolicyProtectedBase.sol";
import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DeskLedger — licences, budgets, clearance, Chief approval and judgments for AI trading agents
/// @notice Practice-trade ledger. Chainlink CRE workflows deliver CLEARANCE, TRADE and JUDGMENT reports through the
///         forwarder. A rejected trade is recorded as an event instead of reverting, because the simulation forwarder
///         swallows receiver reverts and the rejection is the evidence.
contract DeskLedger is ReceiverTemplate, PolicyProtectedBase, EIP712 {
    using SafeERC20 for IERC20;

    enum Action {
        Clearance,
        Trade,
        Judgment,
        Refusal
    }

    enum Verdict {
        Cleared,
        Flagged,
        Blocked
    }

    enum LicenceStatus {
        None,
        Active,
        Suspended
    }

    enum Side {
        Buy,
        Sell
    }

    struct Licence {
        LicenceStatus status;
        bytes32 mandateHash;
        uint256 bond;
        uint256 allocation;
        uint256 spent;
        string name;
    }

    struct Clearance {
        address trader;
        address token;
        uint256 notional;
        Verdict verdict;
        bool used;
        bool exists;
    }

    struct Trade {
        bytes32 clearanceId;
        address trader;
        address token;
        Side side;
        uint256 notional;
        uint256 nonce;
        bytes32 trailHash;
    }

    /// @notice The Chief's signed "no" to a cleared trade. It uses up the clearance, so it cannot be traded later.
    struct Refusal {
        bytes32 clearanceId;
        address trader;
        bytes32 reasonHash;
        bytes32 trailHash;
    }

    struct Judgment {
        bytes32 caseId;
        address defendant;
        uint8 sanctions;
        uint256 slashAmount;
        bytes32 caseHash;
    }

    bytes32 public constant TRADE_TYPEHASH = keccak256(
        "Trade(bytes32 clearanceId,address trader,address token,uint8 side,uint256 notional,uint256 nonce,bytes32 trailHash)"
    );
    bytes32 public constant REFUSAL_TYPEHASH =
        keccak256("Refusal(bytes32 clearanceId,address trader,bytes32 reasonHash,bytes32 trailHash)");
    bytes32 public constant JUDGMENT_TYPEHASH =
        keccak256("Judgment(bytes32 caseId,address defendant,uint8 sanctions,uint256 slashAmount,bytes32 caseHash)");
    /// @notice ACE selector the trade policies are attached to; payload data is abi.encode(trader, token, notional).
    bytes4 public constant TRADE_POLICY_SELECTOR = bytes4(keccak256("recordTrade(address,address,uint256)"));

    uint8 public constant SANCTION_SLASH_BOND = 1;
    uint8 public constant SANCTION_SUSPEND_LICENCE = 2;
    uint8 public constant SANCTION_REVOKE_AUTO_APPROVE = 4;
    uint256 public constant AUTO_APPROVE_REVOCATION = 24 hours;

    IERC20 public immutable bondToken;
    address public chief;
    address public human;
    address public restitution;

    uint256 public deskBudget;
    uint256 public totalAllocated;
    uint256 public autoApproveLimit;
    uint256 public autoApproveSuspendedUntil;
    uint256 public coSignThreshold = type(uint256).max;

    mapping(address => Licence) private s_licences;
    mapping(bytes32 => Clearance) private s_clearances;
    mapping(bytes32 => bool) public tradeSeen;
    mapping(bytes32 => bool) public caseClosed;
    address[] private s_licensees;

    event TraderLicensed(address indexed trader, string name, bytes32 mandateHash);
    event LicenceReinstated(address indexed trader);
    event BondPosted(address indexed trader, address indexed from, uint256 amount);
    event DeskFunded(uint256 amount, uint256 deskBudget);
    event AllocationSet(address indexed trader, uint256 allocation, uint256 totalAllocated);
    event AutoApproveLimitSet(uint256 limit);
    event CoSignThresholdSet(uint256 threshold);
    event RolesSet(address chief, address human, address restitution);
    event ClearanceRecorded(
        bytes32 indexed clearanceId,
        address indexed trader,
        address token,
        uint256 notional,
        Verdict verdict,
        bytes32 findingsHash,
        string reason
    );
    event TradeRecorded(
        bytes32 indexed tradeId,
        bytes32 indexed clearanceId,
        address indexed trader,
        address token,
        Side side,
        uint256 notional,
        bool autoApproved,
        bytes32 trailHash
    );
    event TradeRejected(bytes32 indexed tradeId, bytes32 indexed clearanceId, address indexed trader, string reason);
    event TradeRefused(bytes32 indexed clearanceId, address indexed trader, string reason, bytes32 trailHash);
    event RefusalRejected(bytes32 indexed clearanceId, address indexed trader, string reason);
    event JudgmentRecorded(
        bytes32 indexed caseId, address indexed defendant, uint8 sanctions, uint256 slashed, bytes32 caseHash
    );
    event JudgmentRejected(bytes32 indexed caseId, address indexed defendant, string reason);

    error UnknownAction(uint8 action);
    error NotChief();
    error NotHuman();
    error NotLicensed(address trader);
    error AlreadyLicensed(address trader);
    error OverDeskBudget(uint256 requested, uint256 available);

    modifier onlyChief() {
        if (msg.sender != chief) revert NotChief();
        _;
    }

    modifier onlyHuman() {
        if (msg.sender != human) revert NotHuman();
        _;
    }

    constructor(address forwarder, address policyEngine, address bondToken_, address chief_, address human_)
        ReceiverTemplate(forwarder)
        PolicyProtectedBase(policyEngine)
        EIP712("DueProcessDesk", "1")
    {
        bondToken = IERC20(bondToken_);
        chief = chief_;
        human = human_;
        restitution = human_;
        emit RolesSet(chief_, human_, human_);
    }

    // ------------------------------------------------------------------ admin (direct transactions)

    function setRoles(address chief_, address human_, address restitution_) external onlyOwner {
        chief = chief_;
        human = human_;
        restitution = restitution_;
        emit RolesSet(chief_, human_, restitution_);
    }

    function registerTrader(address trader, string calldata name, bytes32 mandateHash) external onlyOwner {
        Licence storage l = s_licences[trader];
        if (l.status != LicenceStatus.None) revert AlreadyLicensed(trader);
        l.status = LicenceStatus.Active;
        l.name = name;
        l.mandateHash = mandateHash;
        s_licensees.push(trader);
        emit TraderLicensed(trader, name, mandateHash);
    }

    /// @notice Anyone (normally the desk) can post bond for a licensee; it can only leave through a judgment.
    function postBond(address trader, uint256 amount) external {
        Licence storage l = s_licences[trader];
        if (l.status == LicenceStatus.None) revert NotLicensed(trader);
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        l.bond += amount;
        emit BondPosted(trader, msg.sender, amount);
    }

    /// @notice Only the human can raise the desk's total budget; the Chief can only divide it.
    function fundDesk(uint256 amount) external onlyHuman {
        deskBudget += amount;
        emit DeskFunded(amount, deskBudget);
    }

    function setCoSignThreshold(uint256 threshold) external onlyHuman {
        coSignThreshold = threshold;
        emit CoSignThresholdSet(threshold);
    }

    function reinstate(address trader) external onlyHuman {
        Licence storage l = s_licences[trader];
        if (l.status == LicenceStatus.None) revert NotLicensed(trader);
        l.status = LicenceStatus.Active;
        emit LicenceReinstated(trader);
    }

    function setAllocation(address trader, uint256 allocation) external onlyChief {
        Licence storage l = s_licences[trader];
        if (l.status == LicenceStatus.None) revert NotLicensed(trader);
        uint256 nextTotal = totalAllocated - l.allocation + allocation;
        if (nextTotal > deskBudget) revert OverDeskBudget(allocation, deskBudget - (totalAllocated - l.allocation));
        totalAllocated = nextTotal;
        l.allocation = allocation;
        emit AllocationSet(trader, allocation, nextTotal);
    }

    function setAutoApproveLimit(uint256 limit) external onlyChief {
        autoApproveLimit = limit;
        emit AutoApproveLimitSet(limit);
    }

    // ------------------------------------------------------------------ views

    function licenceOf(address trader) external view returns (Licence memory) {
        return s_licences[trader];
    }

    function clearanceOf(bytes32 clearanceId) external view returns (Clearance memory) {
        return s_clearances[clearanceId];
    }

    function licensees() external view returns (address[] memory) {
        return s_licensees;
    }

    function autoApproveActive() public view returns (bool) {
        return block.timestamp >= autoApproveSuspendedUntil;
    }

    function tradeDigest(Trade memory t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRADE_TYPEHASH, t.clearanceId, t.trader, t.token, uint8(t.side), t.notional, t.nonce, t.trailHash
                )
            )
        );
    }

    function refusalDigest(Refusal memory r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REFUSAL_TYPEHASH, r.clearanceId, r.trader, r.reasonHash, r.trailHash)));
    }

    function judgmentDigest(Judgment memory j) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(JUDGMENT_TYPEHASH, j.caseId, j.defendant, j.sanctions, j.slashAmount, j.caseHash))
        );
    }

    // ------------------------------------------------------------------ CRE reports

    function _processReport(bytes calldata report) internal override {
        (uint8 action, bytes memory body) = abi.decode(report, (uint8, bytes));
        if (action == uint8(Action.Clearance)) {
            _recordClearance(body);
        } else if (action == uint8(Action.Trade)) {
            _recordTrade(body);
        } else if (action == uint8(Action.Judgment)) {
            _recordJudgment(body);
        } else if (action == uint8(Action.Refusal)) {
            _recordRefusal(body);
        } else {
            revert UnknownAction(action);
        }
    }

    function _recordClearance(bytes memory body) internal {
        (
            bytes32 id,
            address trader,
            address token,
            uint256 notional,
            uint8 verdict,
            bytes32 findingsHash,
            string memory reason
        ) = abi.decode(body, (bytes32, address, address, uint256, uint8, bytes32, string));
        if (s_clearances[id].exists) return; // idempotent: a retried report must not overwrite the first verdict
        s_clearances[id] = Clearance({
            trader: trader, token: token, notional: notional, verdict: Verdict(verdict), used: false, exists: true
        });
        emit ClearanceRecorded(id, trader, token, notional, Verdict(verdict), findingsHash, reason);
    }

    function _recordTrade(bytes memory body) internal {
        (Trade memory t, bytes memory chiefSig, bytes memory humanSig) = abi.decode(body, (Trade, bytes, bytes));
        bytes32 tradeId = tradeDigest(t);
        if (tradeSeen[tradeId]) {
            emit TradeRejected(tradeId, t.clearanceId, t.trader, "DUPLICATE_TRADE");
            return;
        }
        tradeSeen[tradeId] = true;

        (string memory reason, bool autoApproved) = _checkTrade(t, tradeId, chiefSig, humanSig);
        if (bytes(reason).length == 0) reason = _runTradePolicies(t);
        if (bytes(reason).length != 0) {
            emit TradeRejected(tradeId, t.clearanceId, t.trader, reason);
            return;
        }

        s_clearances[t.clearanceId].used = true;
        Licence storage l = s_licences[t.trader];
        if (t.side == Side.Buy) {
            l.spent += t.notional;
        } else {
            l.spent = l.spent > t.notional ? l.spent - t.notional : 0;
        }
        emit TradeRecorded(tradeId, t.clearanceId, t.trader, t.token, t.side, t.notional, autoApproved, t.trailHash);
    }

    /// @return reason empty when every desk rule passes; autoApproved true when no Chief signature was needed
    function _checkTrade(Trade memory t, bytes32 tradeId, bytes memory chiefSig, bytes memory humanSig)
        internal
        view
        returns (string memory reason, bool autoApproved)
    {
        Licence storage l = s_licences[t.trader];
        if (l.status != LicenceStatus.Active) return ("LICENCE_NOT_ACTIVE", false);

        Clearance storage c = s_clearances[t.clearanceId];
        if (!c.exists) return ("NO_CLEARANCE", false);
        if (c.trader != t.trader || c.token != t.token) return ("CLEARANCE_MISMATCH", false);
        if (c.verdict == Verdict.Blocked) return ("CLEARANCE_BLOCKED", false);
        if (c.used) return ("CLEARANCE_ALREADY_USED", false);
        if (t.notional > c.notional) return ("EXCEEDS_CLEARED_AMOUNT", false);

        // Flagged clearances always need the Chief's eyes, however small the trade.
        autoApproved = c.verdict == Verdict.Cleared && t.notional <= autoApproveLimit && autoApproveActive();
        if (!autoApproved && !_signedBy(tradeId, chiefSig, chief)) return ("CHIEF_APPROVAL_MISSING", false);
        if (t.notional > coSignThreshold && !_signedBy(tradeId, humanSig, human)) {
            return ("HUMAN_COSIGN_MISSING", false);
        }
        if (t.side == Side.Buy && l.spent + t.notional > l.allocation) return ("OVER_ALLOCATION", false);
        return ("", autoApproved);
    }

    function _runTradePolicies(Trade memory t) internal returns (string memory) {
        IPolicyEngine.Payload memory payload = IPolicyEngine.Payload({
            selector: TRADE_POLICY_SELECTOR, sender: t.trader, data: abi.encode(t.trader, t.token, t.notional), context: ""
        });
        try s_policyEngine.run(payload) {
            return "";
        } catch (bytes memory err) {
            return string.concat("POLICY_REJECTED: ", _policyRejectReason(err));
        }
    }

    function _recordRefusal(bytes memory body) internal {
        (Refusal memory r, string memory reason, bytes memory chiefSig) = abi.decode(body, (Refusal, string, bytes));
        Clearance storage c = s_clearances[r.clearanceId];
        string memory problem;
        if (!c.exists) problem = "NO_CLEARANCE";
        else if (c.trader != r.trader) problem = "CLEARANCE_MISMATCH";
        else if (c.used) problem = "CLEARANCE_ALREADY_USED";
        else if (keccak256(bytes(reason)) != r.reasonHash) problem = "REASON_MISMATCH";
        else if (!_signedBy(refusalDigest(r), chiefSig, chief)) problem = "CHIEF_SIGNATURE_MISSING";
        if (bytes(problem).length != 0) {
            emit RefusalRejected(r.clearanceId, r.trader, problem);
            return;
        }
        c.used = true;
        emit TradeRefused(r.clearanceId, r.trader, reason, r.trailHash);
    }

    function _recordJudgment(bytes memory body) internal {
        (Judgment memory j, bytes memory humanSig) = abi.decode(body, (Judgment, bytes));
        if (caseClosed[j.caseId]) {
            emit JudgmentRejected(j.caseId, j.defendant, "CASE_ALREADY_CLOSED");
            return;
        }
        if (!_signedBy(judgmentDigest(j), humanSig, human)) {
            emit JudgmentRejected(j.caseId, j.defendant, "HUMAN_APPROVAL_MISSING");
            return;
        }
        caseClosed[j.caseId] = true;

        Licence storage l = s_licences[j.defendant];
        uint256 slashed;
        if (j.sanctions & SANCTION_SLASH_BOND != 0) {
            slashed = j.slashAmount < l.bond ? j.slashAmount : l.bond;
            l.bond -= slashed;
            if (slashed > 0) bondToken.safeTransfer(restitution, slashed);
        }
        if (j.sanctions & SANCTION_SUSPEND_LICENCE != 0 && l.status == LicenceStatus.Active) {
            l.status = LicenceStatus.Suspended;
        }
        if (j.sanctions & SANCTION_REVOKE_AUTO_APPROVE != 0) {
            autoApproveSuspendedUntil = block.timestamp + AUTO_APPROVE_REVOCATION;
        }
        emit JudgmentRecorded(j.caseId, j.defendant, j.sanctions, slashed, j.caseHash);
    }

    // ------------------------------------------------------------------ internals

    function _signedBy(bytes32 digest, bytes memory sig, address signer) internal pure returns (bool) {
        if (signer == address(0) || sig.length != 65) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer;
    }

    /// @dev Extracts the human-readable reason from PolicyEngine's PolicyRunRejected(address,string,Payload).
    function _policyRejectReason(bytes memory err) internal pure returns (string memory) {
        if (err.length < 4) return "policy error";
        bytes4 selector;
        assembly {
            selector := mload(add(err, 32))
        }
        if (selector != IPolicyEngine.PolicyRunRejected.selector) return "policy error";
        assembly {
            let len := mload(err)
            err := add(err, 4)
            mstore(err, sub(len, 4))
        }
        (, string memory reason,) = abi.decode(err, (address, string, IPolicyEngine.Payload));
        return reason;
    }

    function _authorizeAttachPolicyEngine(address) internal view override onlyOwner {}

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ReceiverTemplate, PolicyProtectedBase)
        returns (bool)
    {
        return ReceiverTemplate.supportsInterface(interfaceId) || PolicyProtectedBase.supportsInterface(interfaceId);
    }
}
