// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {StakeVault} from "./StakeVault.sol";

/**
 * @title StakeVaultFactory
 * @notice Deploys per-payer `StakeVault`s as EIP-1167 minimal proxies via
 *         deterministic CREATE2. The salt commits to the payer address and the
 *         clone is initialized to that same payer, so the vault address is a
 *         pure function of `payer`: anyone may trigger deployment, but only the
 *         payer ever controls the funds.
 * @dev Deliberately **feeless, ownerless, and pauseless** — the rail is a
 *      neutral public good. The factory's only state is the USDC token address
 *      (immutable) and the payer→vault registry. No fee, no owner, no treasury,
 *      no pause: this is the x402-aligned base layer. Any fee lives off-chain at
 *      the facilitator.
 * @custom:security-invariant no_owner no_fee no_pause counterfactual_salt_commits_to_payer
 */
contract StakeVaultFactory {
    /// @notice USDC token every vault from this factory settles in.
    address public immutable usdc;
    /// @notice The locked implementation cloned for each payer.
    address public immutable vaultImpl;

    mapping(address payer => address vault) public vaults;

    event VaultCreated(address indexed payer, address vault);

    error ZeroAddress();
    error AlreadyCreated();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = _usdc;
        vaultImpl = address(new StakeVault());
    }

    /**
     * @notice Permissionlessly deploys `payer`'s deterministic vault and binds
     *         it to `payer`. Reverts if already deployed.
     * @return vault The deployed vault address.
     */
    function createVault(address payer) external returns (address vault) {
        if (payer == address(0)) revert ZeroAddress();
        if (vaults[payer] != address(0)) revert AlreadyCreated();

        bytes32 salt = bytes32(uint256(uint160(payer)));
        vault = Clones.cloneDeterministic(vaultImpl, salt);
        vaults[payer] = vault;

        StakeVault(vault).initialize(payer);

        emit VaultCreated(payer, vault);
    }

    /// @notice Predicts a payer's vault address without deploying (counterfactual).
    function computeVaultAddress(address payer) external view returns (address) {
        return Clones.predictDeterministicAddress(vaultImpl, bytes32(uint256(uint160(payer))), address(this));
    }
}
