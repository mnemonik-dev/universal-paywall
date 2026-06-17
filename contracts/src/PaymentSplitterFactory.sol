// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PaymentVaultImpl} from "./PaymentVaultImpl.sol";

/**
 * @title PaymentSplitterFactory
 * @notice Deploys per-developer USDC vaults as EIP-1167 minimal proxies via
 *         deterministic CREATE2. The factory owns the platform's fee
 *         configuration and treasury address; vaults read these values back
 *         at withdraw time so fee updates apply uniformly to every vault.
 * @dev Architecture pins: D3 (per-developer vault, `cloneDeterministic`),
 *      D4 (split in `withdraw`), D10 (configurable fee, hard cap 1000 bps),
 *      D11 (settable treasury, independent of owner), D12 (Pausable enforced
 *      off-chain in middleware; `register` is paused but `withdraw` is not).
 */
contract PaymentSplitterFactory is Ownable2Step, Pausable {
    IERC20 public immutable usdc;
    address public platformTreasury;
    uint16 public feeBps;
    address public immutable vaultImpl;

    mapping(address developer => address vault) public vaults;

    event VaultDeployed(address indexed developer, address indexed vault);
    event FeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event PlatformTreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error AlreadyRegistered();
    error InvalidFeeBps();
    error ZeroAddress();

    /**
     * @param _usdc Production USDC contract on the target chain.
     * @param _platformTreasury EOA or multisig that receives the platform fee.
     * @param _initialFeeBps Initial fee in basis points (0..1000).
     */
    constructor(IERC20 _usdc, address _platformTreasury, uint16 _initialFeeBps) Ownable(msg.sender) {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (_platformTreasury == address(0)) revert ZeroAddress();
        if (_initialFeeBps > 1000) revert InvalidFeeBps();

        usdc = _usdc;
        platformTreasury = _platformTreasury;
        feeBps = _initialFeeBps;
        vaultImpl = address(new PaymentVaultImpl());
    }

    /**
     * @notice Deploys the caller's vault deterministically.
     * @dev Salt = `bytes32(uint256(uint160(msg.sender)))` so middleware can
     *      compute the payTo address off-chain without an RPC call.
     */
    function register() external whenNotPaused returns (address vault) {
        if (vaults[msg.sender] != address(0)) revert AlreadyRegistered();

        bytes32 salt = bytes32(uint256(uint160(msg.sender)));
        vault = Clones.cloneDeterministic(vaultImpl, salt);
        vaults[msg.sender] = vault;

        PaymentVaultImpl(vault).initialize(msg.sender);

        emit VaultDeployed(msg.sender, vault);
    }

    /// @notice Predicts the vault address for `developer` without deploying.
    function computeVaultAddress(address developer) external view returns (address) {
        return Clones.predictDeterministicAddress(
            vaultImpl,
            bytes32(uint256(uint160(developer))),
            address(this)
        );
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > 1000) revert InvalidFeeBps();
        uint16 oldBps = feeBps;
        feeBps = newBps;
        emit FeeBpsUpdated(oldBps, newBps);
    }

    function setPlatformTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = platformTreasury;
        platformTreasury = newTreasury;
        emit PlatformTreasuryUpdated(oldTreasury, newTreasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
