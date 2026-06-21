// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC3009
 * @notice Minimal EIP-3009 (`transferWithAuthorization`) interface.
 * @dev Off-chain ABI helper consumed by the middleware verify/settle path and
 *      the Foundry test mock. The production USDC contract on Arc Testnet
 *      implements this same surface (see scripts/arc-testnet-usdc-domain.json
 *      from Task 3).
 */
interface IERC3009 {
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
