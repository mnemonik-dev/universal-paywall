// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IUsdcReceiver {
    function onUsdcReceived() external;
}

/**
 * @title MockUsdcWithHook
 * @notice Test-only ERC20 with a post-transfer receiver callback used by the
 *         reentrancy-attack vector tests. Real USDC has no receiver hook, but
 *         to dynamically exercise the `nonReentrant` guard on
 *         `PaymentVaultImpl.withdraw` we need a token that calls back into a
 *         contract recipient on receipt.
 * @dev Test-only mock — NOT for production deployment. Filtered out of Slither
 *      via `filter_paths: "test/,lib/"` in `slither.config.json`.
 *
 *      The hook fires from `_update` (called by `_transfer` and `_mint`). It
 *      only fires when `to` is a contract AND `to.code.length > 0` AND the
 *      `hooksEnabled` flag is set — so tests can stage mints to a vault
 *      without triggering the hook on the vault itself.
 * @custom:test-only
 */
contract MockUsdcWithHook is ERC20 {
    bool public hooksEnabled;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHooksEnabled(bool enabled) external {
        hooksEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hooksEnabled && to.code.length > 0) {
            IUsdcReceiver(to).onUsdcReceived();
        }
    }
}
