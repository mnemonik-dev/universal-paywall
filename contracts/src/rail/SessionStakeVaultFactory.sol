// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SessionStakeVault} from "./SessionStakeVault.sol";

/**
 *  Deploys deterministic per-payer vaults for synchronous paid sessions.
 */
contract SessionStakeVaultFactory {
    address public immutable usdc;
    address public immutable vaultImpl;

    mapping(address payer => address vault) public vaults;

    event VaultCreated(address indexed payer, address vault);

    error ZeroAddress();
    error AlreadyCreated();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = _usdc;
        vaultImpl = address(new SessionStakeVault());
    }

    function createVault(address payer) external returns (address vault) {
        if (payer == address(0)) revert ZeroAddress();
        if (vaults[payer] != address(0)) revert AlreadyCreated();
        bytes32 salt = bytes32(uint256(uint160(payer)));
        vault = Clones.cloneDeterministic(vaultImpl, salt);
        vaults[payer] = vault;
        SessionStakeVault(vault).initialize(payer);
        emit VaultCreated(payer, vault);
    }

    function computeVaultAddress(address payer) external view returns (address) {
        return Clones.predictDeterministicAddress(vaultImpl, bytes32(uint256(uint160(payer))), address(this));
    }
}
