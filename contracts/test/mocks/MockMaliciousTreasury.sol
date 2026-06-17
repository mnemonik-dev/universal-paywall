// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPaymentVaultLike {
    function withdraw() external;
}

/**
 * @title MockMaliciousTreasury
 * @notice Stand-in `platformTreasury` that re-enters `vault.withdraw()` on the
 *         fee transfer's receiver hook. Paired with `MockUsdcWithHook` so the
 *         fee `safeTransfer(treasury, fee)` from `PaymentVaultImpl.withdraw`
 *         triggers `onUsdcReceived()` on this contract.
 * @dev If the vault's `nonReentrant` guard works correctly, the re-entered
 *      `withdraw()` reverts with `ReentrancyGuardReentrantCall` and that revert
 *      propagates back through the ERC20 `_update` hook → fee `safeTransfer`
 *      → outer `withdraw()`, undoing the developer-first transfer.
 * @custom:test-only
 */
contract MockMaliciousTreasury {
    IPaymentVaultLike public target;
    uint256 public reentryCount;

    function setTarget(IPaymentVaultLike _target) external {
        target = _target;
    }

    function onUsdcReceived() external {
        reentryCount++;
        target.withdraw();
    }
}
