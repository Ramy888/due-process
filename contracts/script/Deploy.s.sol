// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";
import {PolicyEngineFactory} from "@chainlink/policy-management/core/PolicyEngineFactory.sol";
import {PolicyFactory} from "@chainlink/policy-management/core/PolicyFactory.sol";
import {MaxPolicy} from "@chainlink/policy-management/policies/MaxPolicy.sol";
import {RejectPolicy} from "@chainlink/policy-management/policies/RejectPolicy.sol";
import {DeskLedger} from "../src/DeskLedger.sol";
import {TradeExtractor} from "../src/policy/TradeExtractor.sol";
import {FrogToken} from "../src/demo/FrogToken.sol";

/// Local-chain stand-in for USDC (anvil only).
contract LocalUSDC is ERC20 {
    constructor(address to) ERC20("Local USDC", "USDC") {
        _mint(to, 1_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// Deploys the whole desk: ACE policy engine + policies, DeskLedger, the staged FROG token, licences, bonds, budgets.
/// Env: DESK/CHIEF/HUMAN_APPROVER/FROG_DEPLOYER/TRADER_*_PRIVATE_KEY, FORWARDER, optional BOND_TOKEN (else LocalUSDC).
contract Deploy is Script {
    uint256 constant MAX_TRADE = 1_500e6; // ACE MaxPolicy: per-trade ceiling (paper USD, 6 decimals)
    uint256 constant DESK_BUDGET = 10_000e6;
    uint256 constant ALLOCATION = 2_000e6;
    uint256 constant AUTO_APPROVE = 100e6;
    uint256 constant CO_SIGN = 150e6;
    uint256 constant BOND = 1e6; // 1 test USDC per licensee
    uint256 constant GAS_TOPUP = 0.0005 ether;

    uint256 constant N_TRADERS = 5;

    /// Licence texts and persona handles come from data/ so the on-chain mandate hashes match what the server compiles.
    function dataFile(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../data/", name));
    }

    function field(string memory json, string memory path) internal pure returns (string memory) {
        return vm.parseJsonString(json, path);
    }

    function at(string memory list, uint256 i, string memory key) internal pure returns (string memory) {
        return string.concat(".", list, "[", vm.toString(i), "].", key);
    }

    /// Same derivation as server/src/personas.ts: last 20 bytes of keccak256("due-process:persona:<handle>").
    function persona(string memory handle) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("due-process:persona:", handle)))));
    }

    function run() external {
        uint256 deskPk = vm.envUint("DESK_PRIVATE_KEY");
        uint256 chiefPk = vm.envUint("CHIEF_PRIVATE_KEY");
        uint256 humanPk = vm.envUint("HUMAN_APPROVER_PRIVATE_KEY");
        uint256 frogPk = vm.envUint("FROG_DEPLOYER_PRIVATE_KEY");
        address forwarder = vm.envAddress("FORWARDER");
        address desk = vm.addr(deskPk);
        address chief = vm.addr(chiefPk);
        address human = vm.addr(humanPk);
        address frogDeployer = vm.addr(frogPk);
        string memory roster = dataFile("traders.json");
        string memory personas = dataFile("personas.json");
        address[N_TRADERS] memory traders;
        for (uint256 i = 0; i < N_TRADERS; i++) {
            traders[i] = vm.addr(vm.envUint(string.concat(field(roster, at("traders", i, "key")), "_PRIVATE_KEY")));
        }

        // ---- desk: engine, policies, ledger
        vm.startBroadcast(deskPk);
        address bondToken = vm.envOr("BOND_TOKEN", address(0));
        if (bondToken == address(0)) bondToken = address(new LocalUSDC(desk));

        PolicyEngine engine = PolicyEngine(
            new PolicyEngineFactory().createUpgradeablePolicyEngine(address(new PolicyEngine()), bytes32(0), true, desk)
        );
        DeskLedger ledger = new DeskLedger(forwarder, address(engine), bondToken, chief, human);
        TradeExtractor extractor = new TradeExtractor();
        engine.setExtractor(ledger.TRADE_POLICY_SELECTOR(), address(extractor));

        PolicyFactory policies = new PolicyFactory();
        address rejectPolicy = policies.createUpgradeablePolicy(
            address(new RejectPolicy()), bytes32(uint256(1)), address(engine), desk, ""
        );
        address maxPolicy = policies.createUpgradeablePolicy(
            address(new MaxPolicy()), bytes32(uint256(2)), address(engine), desk, abi.encode(MAX_TRADE)
        );
        bytes32[] memory tokenParam = new bytes32[](1);
        tokenParam[0] = extractor.PARAM_TOKEN();
        engine.addPolicy(address(ledger), ledger.TRADE_POLICY_SELECTOR(), rejectPolicy, tokenParam);
        bytes32[] memory amountParam = new bytes32[](1);
        amountParam[0] = extractor.PARAM_AMOUNT();
        engine.addPolicy(address(ledger), ledger.TRADE_POLICY_SELECTOR(), maxPolicy, amountParam);

        for (uint256 i = 0; i < N_TRADERS; i++) {
            ledger.registerTrader(
                traders[i], field(roster, at("traders", i, "name")), keccak256(bytes(field(roster, at("traders", i, "mandate"))))
            );
        }
        ledger.registerTrader(chief, field(roster, ".chief.name"), keccak256(bytes(field(roster, ".chief.mandate"))));

        IERC20(bondToken).approve(address(ledger), type(uint256).max);
        for (uint256 i = 0; i < N_TRADERS; i++) {
            ledger.postBond(traders[i], BOND);
        }
        ledger.postBond(chief, BOND);

        payable(chief).transfer(GAS_TOPUP);
        payable(human).transfer(GAS_TOPUP);
        payable(frogDeployer).transfer(GAS_TOPUP * 4);
        vm.stopBroadcast();

        // ---- human: desk budget and co-sign threshold
        vm.startBroadcast(humanPk);
        ledger.fundDesk(DESK_BUDGET);
        ledger.setCoSignThreshold(CO_SIGN);
        vm.stopBroadcast();

        // ---- chief: allocations and auto-approve limit
        vm.startBroadcast(chiefPk);
        for (uint256 i = 0; i < N_TRADERS; i++) {
            ledger.setAllocation(traders[i], ALLOCATION);
        }
        ledger.setAutoApproveLimit(AUTO_APPROVE);
        vm.stopBroadcast();

        // ---- staged scam: FROG deployer keeps mint authority and most supply, pre-funds 4 of 6 promoters
        vm.startBroadcast(frogPk);
        FrogToken frog = new FrogToken(1_000_000 ether);
        for (uint256 i = 0; i < 4; i++) {
            frog.transfer(persona(field(personas, at("kols", i, "handle"))), 25_000 ether);
        }
        vm.stopBroadcast();

        string memory out = "deployment";
        vm.serializeUint(out, "chainId", block.chainid);
        vm.serializeAddress(out, "forwarder", forwarder);
        vm.serializeAddress(out, "bondToken", bondToken);
        vm.serializeAddress(out, "policyEngine", address(engine));
        vm.serializeAddress(out, "maxPolicy", maxPolicy);
        vm.serializeAddress(out, "rejectPolicy", rejectPolicy);
        vm.serializeAddress(out, "frogToken", address(frog));
        vm.serializeAddress(out, "frogDeployer", frogDeployer);
        string memory json = vm.serializeAddress(out, "deskLedger", address(ledger));
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.envOr("DEPLOY_NAME", string("local")), ".json");
        vm.writeJson(json, path);
        console2.log("DeskLedger", address(ledger));
        console2.log("FROG", address(frog));
    }
}
