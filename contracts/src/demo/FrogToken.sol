// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title FrogToken — STAGED demo token with planted red flags (testnet only)
/// @notice The deployer keeps mint authority and most of the supply, and seeds promoter wallets before they "shill" it.
///         The clearance workflow must catch all of it from on-chain data alone.
contract FrogToken is ERC20, Ownable {
    bool public mintingEnabled = true;

    constructor(uint256 initialSupply) ERC20("Frog (Due Process demo)", "FROG") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        require(mintingEnabled, "minting disabled");
        _mint(to, amount);
    }

    function renounceMinting() external onlyOwner {
        mintingEnabled = false;
    }
}
