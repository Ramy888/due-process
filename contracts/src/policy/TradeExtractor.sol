// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IExtractor} from "@chainlink/policy-management/interfaces/IExtractor.sol";
import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";

/// @notice Decodes a DeskLedger trade payload into named ACE parameters.
/// @dev Payload data layout: abi.encode(address trader, address token, uint256 notional).
contract TradeExtractor is IExtractor {
    string public constant override typeAndVersion = "DueProcessTradeExtractor 1.0.0";

    bytes32 public constant PARAM_TRADER = keccak256("trader");
    bytes32 public constant PARAM_TOKEN = keccak256("token");
    bytes32 public constant PARAM_AMOUNT = keccak256("amount");

    function extract(IPolicyEngine.Payload calldata payload)
        external
        pure
        override
        returns (IPolicyEngine.Parameter[] memory result)
    {
        (address trader, address token, uint256 notional) = abi.decode(payload.data, (address, address, uint256));
        result = new IPolicyEngine.Parameter[](3);
        result[0] = IPolicyEngine.Parameter(PARAM_TRADER, abi.encode(trader));
        result[1] = IPolicyEngine.Parameter(PARAM_TOKEN, abi.encode(token));
        result[2] = IPolicyEngine.Parameter(PARAM_AMOUNT, abi.encode(notional));
    }
}
