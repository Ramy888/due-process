// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";
import {PolicyEngineFactory} from "@chainlink/policy-management/core/PolicyEngineFactory.sol";
import {PolicyFactory} from "@chainlink/policy-management/core/PolicyFactory.sol";
import {MaxPolicy} from "@chainlink/policy-management/policies/MaxPolicy.sol";
import {RejectPolicy} from "@chainlink/policy-management/policies/RejectPolicy.sol";
import {TradeExtractor} from "../src/policy/TradeExtractor.sol";

/// Spike: can a contract run ACE policies and RECORD a rejection instead of reverting?
contract SpikeTarget {
    bytes4 public constant TRADE_SELECTOR = bytes4(keccak256("recordTrade(address,address,uint256)"));
    IPolicyEngine public immutable engine;
    bool public lastAllowed;
    string public lastReason;

    constructor(IPolicyEngine engine_) {
        engine = engine_;
    }

    function attach() external {
        engine.attach();
    }

    function tryTrade(address trader, address token, uint256 notional) external {
        IPolicyEngine.Payload memory p = IPolicyEngine.Payload({
            selector: TRADE_SELECTOR, sender: address(this), data: abi.encode(trader, token, notional), context: ""
        });
        try engine.run(p) {
            lastAllowed = true;
            lastReason = "";
        } catch (bytes memory err) {
            lastAllowed = false;
            lastReason = _reason(err);
        }
    }

    function _reason(bytes memory err) internal pure returns (string memory) {
        if (err.length < 4) return "policy error";
        bytes4 sel;
        assembly {
            sel := mload(add(err, 32))
        }
        if (sel != IPolicyEngine.PolicyRunRejected.selector) return "policy error";
        assembly {
            let len := mload(err)
            err := add(err, 4)
            mstore(err, sub(len, 4))
        }
        (, string memory reason,) = abi.decode(err, (address, string, IPolicyEngine.Payload));
        return reason;
    }
}

contract AceSpikeTest is Test {
    address admin = address(this);
    address trader = address(0xA11CE);
    address goodToken = address(0x600D);
    address sanctionedToken = address(0xBAD);
    SpikeTarget target;

    function setUp() public {
        PolicyEngine engine = PolicyEngine(
            new PolicyEngineFactory().createUpgradeablePolicyEngine(address(new PolicyEngine()), bytes32(0), true, admin)
        );
        PolicyFactory pf = new PolicyFactory();
        address maxPolicy = pf.createUpgradeablePolicy(
            address(new MaxPolicy()), bytes32(uint256(1)), address(engine), admin, abi.encode(uint256(500e6))
        );
        address rejectPolicy = pf.createUpgradeablePolicy(
            address(new RejectPolicy()), bytes32(uint256(2)), address(engine), admin, ""
        );
        RejectPolicy(rejectPolicy).rejectAddress(sanctionedToken);

        target = new SpikeTarget(engine);
        target.attach();
        TradeExtractor ex = new TradeExtractor();
        engine.setExtractor(target.TRADE_SELECTOR(), address(ex));

        bytes32[] memory tokenParam = new bytes32[](1);
        tokenParam[0] = ex.PARAM_TOKEN();
        engine.addPolicy(address(target), target.TRADE_SELECTOR(), rejectPolicy, tokenParam);
        bytes32[] memory amountParam = new bytes32[](1);
        amountParam[0] = ex.PARAM_AMOUNT();
        engine.addPolicy(address(target), target.TRADE_SELECTOR(), maxPolicy, amountParam);
    }

    function test_allowsTradeWithinPolicy() public {
        target.tryTrade(trader, goodToken, 400e6);
        assertTrue(target.lastAllowed());
    }

    function test_recordsMaxPolicyRejectionWithoutReverting() public {
        target.tryTrade(trader, goodToken, 600e6);
        assertFalse(target.lastAllowed());
        assertEq(target.lastReason(), "amount exceeds maximum limit");
    }

    function test_recordsRejectPolicyRejectionWithoutReverting() public {
        target.tryTrade(trader, sanctionedToken, 10e6);
        assertFalse(target.lastAllowed());
        assertEq(target.lastReason(), "address is on reject list");
    }
}
