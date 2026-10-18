// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";
import {PolicyEngineFactory} from "@chainlink/policy-management/core/PolicyEngineFactory.sol";
import {PolicyFactory} from "@chainlink/policy-management/core/PolicyFactory.sol";
import {MaxPolicy} from "@chainlink/policy-management/policies/MaxPolicy.sol";
import {RejectPolicy} from "@chainlink/policy-management/policies/RejectPolicy.sol";
import {DeskLedger} from "../src/DeskLedger.sol";
import {TradeExtractor} from "../src/policy/TradeExtractor.sol";
import {ReceiverTemplate} from "../src/cre/ReceiverTemplate.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DeskLedgerTest is Test {
    uint256 constant CHIEF_PK = 0xC41EF;
    uint256 constant HUMAN_PK = 0x4B3A;
    uint256 constant ROGUE_PK = 0xBAD;

    address forwarder = makeAddr("forwarder");
    address chief = vm.addr(CHIEF_PK);
    address human = vm.addr(HUMAN_PK);
    address trader = makeAddr("kolTrader");
    address meme = makeAddr("memeTrader");
    address token = makeAddr("FROG");
    address sanctioned = makeAddr("sanctionedToken");

    DeskLedger desk;
    MockUSDC usdc;
    RejectPolicy rejectPolicy;
    uint256 nonce;

    function setUp() public {
        usdc = new MockUSDC();
        PolicyEngine engine = PolicyEngine(
            new PolicyEngineFactory().createUpgradeablePolicyEngine(
                address(new PolicyEngine()), bytes32(0), true, address(this)
            )
        );
        desk = new DeskLedger(forwarder, address(engine), address(usdc), chief, human);

        PolicyFactory pf = new PolicyFactory();
        TradeExtractor ex = new TradeExtractor();
        engine.setExtractor(desk.TRADE_POLICY_SELECTOR(), address(ex));
        rejectPolicy = RejectPolicy(
            pf.createUpgradeablePolicy(address(new RejectPolicy()), bytes32(uint256(1)), address(engine), address(this), "")
        );
        address maxPolicy = pf.createUpgradeablePolicy(
            address(new MaxPolicy()), bytes32(uint256(2)), address(engine), address(this), abi.encode(uint256(1_500e6))
        );
        bytes32[] memory tokenParam = new bytes32[](1);
        tokenParam[0] = ex.PARAM_TOKEN();
        engine.addPolicy(address(desk), desk.TRADE_POLICY_SELECTOR(), address(rejectPolicy), tokenParam);
        bytes32[] memory amountParam = new bytes32[](1);
        amountParam[0] = ex.PARAM_AMOUNT();
        engine.addPolicy(address(desk), desk.TRADE_POLICY_SELECTOR(), maxPolicy, amountParam);
        rejectPolicy.rejectAddress(sanctioned);

        desk.registerTrader(trader, "KOL Narrative", keccak256("max 5% per position"));
        desk.registerTrader(meme, "Meme Hunter", keccak256("meme mandate"));
        vm.prank(human);
        desk.fundDesk(10_000e6);
        vm.startPrank(chief);
        desk.setAllocation(trader, 2_000e6);
        desk.setAllocation(meme, 2_000e6);
        desk.setAutoApproveLimit(100e6);
        vm.stopPrank();

        usdc.mint(address(this), 100e6);
        usdc.approve(address(desk), type(uint256).max);
        desk.postBond(meme, 50e6);
    }

    // ------------------------------------------------------------------ helpers

    function _report(DeskLedger.Action action, bytes memory body) internal {
        vm.prank(forwarder);
        desk.onReport("", abi.encode(uint8(action), body));
    }

    function _clear(bytes32 id, address who, address tok, uint256 notional, DeskLedger.Verdict verdict) internal {
        _report(
            DeskLedger.Action.Clearance,
            abi.encode(id, who, tok, notional, uint8(verdict), keccak256("findings"), "rule verdict")
        );
    }

    function _trade(bytes32 clearanceId, address who, address tok, uint256 notional)
        internal
        returns (DeskLedger.Trade memory)
    {
        return DeskLedger.Trade({
            clearanceId: clearanceId,
            trader: who,
            token: tok,
            side: DeskLedger.Side.Buy,
            notional: notional,
            nonce: nonce++,
            trailHash: keccak256("trail")
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _submit(DeskLedger.Trade memory t, bytes memory chiefSig, bytes memory humanSig) internal {
        _report(DeskLedger.Action.Trade, abi.encode(t, chiefSig, humanSig));
    }

    /// Submits and returns the single TradeRecorded/TradeRejected outcome.
    function _outcome(DeskLedger.Trade memory t, bytes memory chiefSig, bytes memory humanSig)
        internal
        returns (bool recorded, string memory reason)
    {
        vm.recordLogs();
        _submit(t, chiefSig, humanSig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(desk)) continue;
            if (logs[i].topics[0] == DeskLedger.TradeRecorded.selector) return (true, "");
            if (logs[i].topics[0] == DeskLedger.TradeRejected.selector) {
                return (false, abi.decode(logs[i].data, (string)));
            }
        }
        revert("no trade outcome event");
    }

    function _expectRejected(DeskLedger.Trade memory t, bytes memory chiefSig, bytes memory humanSig, string memory want)
        internal
    {
        (bool recorded, string memory reason) = _outcome(t, chiefSig, humanSig);
        assertFalse(recorded, "trade should be rejected");
        assertEq(reason, want);
    }

    function _chiefSigned(DeskLedger.Trade memory t) internal view returns (bytes memory) {
        return _sign(CHIEF_PK, desk.tradeDigest(t));
    }

    // ------------------------------------------------------------------ clearance + happy path

    function test_recordsClearance() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Clearance memory c = desk.clearanceOf("c1");
        assertTrue(c.exists);
        assertEq(c.notional, 500e6);
    }

    function test_clearanceIsIdempotent() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Blocked);
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        assertEq(uint8(desk.clearanceOf("c1").verdict), uint8(DeskLedger.Verdict.Blocked));
    }

    function test_recordsChiefApprovedTrade() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 500e6);
        (bool recorded,) = _outcome(t, _chiefSigned(t), "");
        assertTrue(recorded);
        assertEq(desk.licenceOf(trader).spent, 500e6);
        assertTrue(desk.clearanceOf("c1").used);
    }

    function test_onlyForwarderCanReport() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
        desk.onReport("", abi.encode(uint8(0), bytes("")));
    }

    // ------------------------------------------------------------------ desk rules

    function test_rejectsUnlicensedTrader() public {
        address stranger = makeAddr("stranger");
        _clear("c1", stranger, token, 50e6, DeskLedger.Verdict.Cleared);
        _expectRejected(_trade("c1", stranger, token, 50e6), "", "", "LICENCE_NOT_ACTIVE");
    }

    function test_rejectsWithoutClearance() public {
        _expectRejected(_trade("missing", trader, token, 50e6), "", "", "NO_CLEARANCE");
    }

    function test_rejectsBlockedClearance() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Blocked);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 500e6);
        _expectRejected(t, _chiefSigned(t), "", "CLEARANCE_BLOCKED");
    }

    function test_rejectsClearanceForAnotherTrader() public {
        _clear("c1", meme, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 500e6);
        _expectRejected(t, _chiefSigned(t), "", "CLEARANCE_MISMATCH");
    }

    function test_rejectsMoreThanCleared() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 501e6);
        _expectRejected(t, _chiefSigned(t), "", "EXCEEDS_CLEARED_AMOUNT");
    }

    function test_rejectsReusedClearance() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory first = _trade("c1", trader, token, 200e6);
        _submit(first, _chiefSigned(first), "");
        DeskLedger.Trade memory second = _trade("c1", trader, token, 200e6);
        _expectRejected(second, _chiefSigned(second), "", "CLEARANCE_ALREADY_USED");
    }

    function test_rejectsReplayedTrade() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 500e6);
        bytes memory sig = _chiefSigned(t);
        _submit(t, sig, "");
        _expectRejected(t, sig, "", "DUPLICATE_TRADE");
    }

    function test_rejectsOverAllocation() public {
        _clear("c1", trader, token, 1_400e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t1 = _trade("c1", trader, token, 1_400e6);
        _submit(t1, _chiefSigned(t1), "");
        _clear("c2", trader, token, 700e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t2 = _trade("c2", trader, token, 700e6);
        _expectRejected(t2, _chiefSigned(t2), "", "OVER_ALLOCATION");
    }

    // ------------------------------------------------------------------ Chief approval

    function test_rejectsMissingChiefSignatureAboveAutoLimit() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        _expectRejected(_trade("c1", trader, token, 500e6), "", "", "CHIEF_APPROVAL_MISSING");
    }

    function test_rejectsSignatureFromSomeoneElse() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 500e6);
        _expectRejected(t, _sign(ROGUE_PK, desk.tradeDigest(t)), "", "CHIEF_APPROVAL_MISSING");
    }

    function test_rejectsChiefSignatureForDifferentTrade() public {
        _clear("c1", trader, token, 500e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory signed = _trade("c1", trader, token, 100e6);
        bytes memory sig = _chiefSigned(signed);
        // memory structs are references: build an independent copy with only the amount changed
        DeskLedger.Trade memory sent = DeskLedger.Trade({
            clearanceId: signed.clearanceId,
            trader: signed.trader,
            token: signed.token,
            side: signed.side,
            notional: 500e6,
            nonce: signed.nonce,
            trailHash: signed.trailHash
        });
        _expectRejected(sent, sig, "", "CHIEF_APPROVAL_MISSING");
    }

    function test_autoApprovesSmallCleanTrade() public {
        _clear("c1", trader, token, 80e6, DeskLedger.Verdict.Cleared);
        vm.expectEmit(false, true, true, true, address(desk));
        emit DeskLedger.TradeRecorded(
            bytes32(0), "c1", trader, token, DeskLedger.Side.Buy, 80e6, true, keccak256("trail")
        );
        _submit(_trade("c1", trader, token, 80e6), "", "");
    }

    function test_flaggedClearanceNeverAutoApproves() public {
        _clear("c1", trader, token, 80e6, DeskLedger.Verdict.Flagged);
        _expectRejected(_trade("c1", trader, token, 80e6), "", "", "CHIEF_APPROVAL_MISSING");
    }

    function test_flaggedClearancePassesWithChiefSignature() public {
        _clear("c1", trader, token, 80e6, DeskLedger.Verdict.Flagged);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 80e6);
        (bool recorded,) = _outcome(t, _chiefSigned(t), "");
        assertTrue(recorded);
    }

    // ------------------------------------------------------------------ human co-sign

    function test_largeTradeNeedsHumanCoSign() public {
        vm.prank(human);
        desk.setCoSignThreshold(1_000e6);
        _clear("c1", trader, token, 1_200e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 1_200e6);
        _expectRejected(t, _chiefSigned(t), "", "HUMAN_COSIGN_MISSING");
    }

    function test_largeTradePassesWithHumanCoSign() public {
        vm.prank(human);
        desk.setCoSignThreshold(1_000e6);
        _clear("c1", trader, token, 1_200e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 1_200e6);
        (bool recorded,) = _outcome(t, _chiefSigned(t), _sign(HUMAN_PK, desk.tradeDigest(t)));
        assertTrue(recorded);
    }

    // ------------------------------------------------------------------ ACE policies

    function test_acePolicyRejectsOversizedTrade() public {
        vm.prank(chief);
        desk.setAllocation(trader, 5_000e6);
        _clear("c1", trader, token, 1_600e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, token, 1_600e6);
        _expectRejected(t, _chiefSigned(t), "", "POLICY_REJECTED: amount exceeds maximum limit");
    }

    function test_acePolicyRejectsDenylistedToken() public {
        _clear("c1", trader, sanctioned, 50e6, DeskLedger.Verdict.Cleared);
        DeskLedger.Trade memory t = _trade("c1", trader, sanctioned, 50e6);
        _expectRejected(t, _chiefSigned(t), "", "POLICY_REJECTED: address is on reject list");
    }

    // ------------------------------------------------------------------ budgets

    function test_onlyChiefSetsAllocations() public {
        vm.expectRevert(DeskLedger.NotChief.selector);
        desk.setAllocation(trader, 1);
    }

    function test_chiefCannotAllocateBeyondDeskBudget() public {
        vm.prank(chief);
        vm.expectRevert(abi.encodeWithSelector(DeskLedger.OverDeskBudget.selector, 8_001e6, 8_000e6));
        desk.setAllocation(trader, 8_001e6);
    }

    function test_onlyHumanFundsDesk() public {
        vm.prank(chief);
        vm.expectRevert(DeskLedger.NotHuman.selector);
        desk.fundDesk(1);
    }

    // ------------------------------------------------------------------ judgments

    function _judgment(bytes32 caseId, address defendant, uint8 sanctions, uint256 slash)
        internal
        pure
        returns (DeskLedger.Judgment memory)
    {
        return DeskLedger.Judgment({
            caseId: caseId, defendant: defendant, sanctions: sanctions, slashAmount: slash, caseHash: keccak256(abi.encode(caseId))
        });
    }

    function _judge(DeskLedger.Judgment memory j, bytes memory sig) internal {
        _report(DeskLedger.Action.Judgment, abi.encode(j, sig));
    }

    function test_judgmentNeedsHumanApproval() public {
        DeskLedger.Judgment memory j = _judgment("case1", meme, desk.SANCTION_SLASH_BOND(), 30e6);
        vm.expectEmit(true, true, false, true, address(desk));
        emit DeskLedger.JudgmentRejected("case1", meme, "HUMAN_APPROVAL_MISSING");
        _judge(j, _sign(CHIEF_PK, desk.judgmentDigest(j)));
        assertEq(desk.licenceOf(meme).bond, 50e6);
    }

    function test_judgmentSlashesBondAndSuspendsLicence() public {
        DeskLedger.Judgment memory j =
            _judgment("case1", meme, desk.SANCTION_SLASH_BOND() | desk.SANCTION_SUSPEND_LICENCE(), 30e6);
        _judge(j, _sign(HUMAN_PK, desk.judgmentDigest(j)));
        assertEq(desk.licenceOf(meme).bond, 20e6);
        assertEq(usdc.balanceOf(human), 30e6, "slashed bond goes to restitution");
        assertEq(uint8(desk.licenceOf(meme).status), uint8(DeskLedger.LicenceStatus.Suspended));

        _clear("c1", meme, token, 50e6, DeskLedger.Verdict.Cleared);
        _expectRejected(_trade("c1", meme, token, 50e6), "", "", "LICENCE_NOT_ACTIVE");
    }

    function test_slashIsCappedAtBond() public {
        DeskLedger.Judgment memory j = _judgment("case1", meme, desk.SANCTION_SLASH_BOND(), 999e6);
        _judge(j, _sign(HUMAN_PK, desk.judgmentDigest(j)));
        assertEq(desk.licenceOf(meme).bond, 0);
        assertEq(usdc.balanceOf(human), 50e6);
    }

    function test_revokingAutoApproveForcesChiefSignature() public {
        DeskLedger.Judgment memory j = _judgment("case1", chief, desk.SANCTION_REVOKE_AUTO_APPROVE(), 0);
        _judge(j, _sign(HUMAN_PK, desk.judgmentDigest(j)));
        assertFalse(desk.autoApproveActive());

        _clear("c1", trader, token, 80e6, DeskLedger.Verdict.Cleared);
        _expectRejected(_trade("c1", trader, token, 80e6), "", "", "CHIEF_APPROVAL_MISSING");

        vm.warp(block.timestamp + 24 hours);
        assertTrue(desk.autoApproveActive());
    }

    function test_caseClosesOnce() public {
        DeskLedger.Judgment memory j = _judgment("case1", meme, desk.SANCTION_SLASH_BOND(), 10e6);
        bytes memory sig = _sign(HUMAN_PK, desk.judgmentDigest(j));
        _judge(j, sig);
        vm.expectEmit(true, true, false, true, address(desk));
        emit DeskLedger.JudgmentRejected("case1", meme, "CASE_ALREADY_CLOSED");
        _judge(j, sig);
        assertEq(desk.licenceOf(meme).bond, 40e6);
    }
}
