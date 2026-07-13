// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ISessionStakeVaultFactory {
    function usdc() external view returns (address);
}

/**
 * @title SessionStakeVault
 * @notice A payer-owned USDC vault for synchronous, operation-bound payments.
 * @dev Unlike the legacy streaming rail, one policy fixes the payee and every
 *      settlement consumes a unique operation digest on-chain. This makes a
 *      provider retry safe even when an RPC result was lost after broadcast.
 */
contract SessionStakeVault is Initializable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    address public payer;
    address public factory;

    struct Policy {
        address facilitator;
        address payTo;
        uint256 cap;
        uint256 spent;
        uint256 perOperationCeiling;
        uint64 validUntil;
        uint64 epoch;
        bytes32 scopeHash;
        bool revoked;
    }

    Policy public policy;
    mapping(bytes32 operationId => bool settled) public settledOperations;
    mapping(bytes32 nonce => bool used) public usedGrantNonces;

    struct SessionGrant {
        bytes32 sessionIdHash;
        address payerWallet;
        address vault;
        address facilitator;
        address payTo;
        uint256 cap;
        uint256 perOperationCeiling;
        uint64 validUntil;
        address asset;
        uint64 policyEpoch;
        bytes32 scopeHash;
        bytes32 nonce;
    }

    bytes32 public constant SESSION_AUTHORIZATION_TYPEHASH = keccak256(
        "SessionAuthorization(bytes32 sessionIdHash,address payerWallet,address vault,address facilitator,address payTo,uint256 cap,uint256 perOperationCeiling,uint64 validUntil,address asset,uint64 policyEpoch,bytes32 scopeHash,bytes32 nonce)"
    );

    event Deposited(address indexed from, uint256 amount);
    event PolicyGranted(
        address indexed facilitator,
        address indexed payTo,
        uint256 cap,
        uint256 perOperationCeiling,
        uint64 validUntil,
        uint64 epoch,
        bytes32 scopeHash
    );
    event PolicyRevoked(uint64 indexed epoch);
    event OperationSettled(
        bytes32 indexed operationId, address indexed payTo, uint256 amount, uint256 spent, uint64 epoch
    );
    event RemainderWithdrawn(address indexed payer, uint256 amount);

    error NotPayer();
    error NotFacilitator();
    error PolicyExpired();
    error PolicyRevokedError();
    error PolicyEpochMismatch();
    error CapExceeded();
    error OperationCeilingExceeded();
    error OperationAlreadySettled();
    error GrantNonceAlreadyUsed();
    error InvalidSessionSignature();
    error SessionGrantMismatch();
    error InsufficientFundedBalance();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroOperationId();
    error InvalidValidUntil();
    error InvalidCeiling();
    error InsufficientUnlocked();

    constructor() EIP712("Universal Paywall Session", "1") {
        _disableInitializers();
    }

    function initialize(address _payer) external initializer {
        if (_payer == address(0)) revert ZeroAddress();
        payer = _payer;
        factory = msg.sender;
    }

    function _usdc() internal view returns (IERC20) {
        return IERC20(ISessionStakeVaultFactory(factory).usdc());
    }

    function usdc() external view returns (address) {
        return address(_usdc());
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _usdc().safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Authorizes one bounded service session. `scopeHash` commits to
     *         the wallet-approved workspace, visibility and checkpoint types;
     *         the HTTP facilitator validates the corresponding cleartext scope.
     */
    function grantPolicy(
        address facilitator,
        address payTo,
        uint256 cap,
        uint256 perOperationCeiling,
        uint64 validUntil,
        bytes32 scopeHash
    ) external {
        if (msg.sender != payer) revert NotPayer();
        _grantPolicy(facilitator, payTo, cap, perOperationCeiling, validUntil, scopeHash);
    }

    /**
     * @notice Relays the same EIP-712 session authorization registered by the
     *         HTTP API. The payer signs once; any relayer may submit it.
     */
    function grantPolicyBySig(SessionGrant calldata grant, bytes calldata signature) external {
        if (grant.payerWallet != payer || grant.vault != address(this) || grant.asset != address(_usdc())) {
            revert SessionGrantMismatch();
        }
        if (grant.policyEpoch != policy.epoch + 1) revert PolicyEpochMismatch();
        if (usedGrantNonces[grant.nonce]) revert GrantNonceAlreadyUsed();
        address recovered = ECDSA.recover(_hashTypedDataV4(_sessionGrantStructHash(grant)), signature);
        if (recovered != payer) revert InvalidSessionSignature();

        usedGrantNonces[grant.nonce] = true;
        _grantPolicy(
            grant.facilitator, grant.payTo, grant.cap, grant.perOperationCeiling, grant.validUntil, grant.scopeHash
        );
    }

    function hashSessionGrant(SessionGrant calldata grant) external view returns (bytes32) {
        return _hashTypedDataV4(_sessionGrantStructHash(grant));
    }

    function _grantPolicy(
        address facilitator,
        address payTo,
        uint256 cap,
        uint256 perOperationCeiling,
        uint64 validUntil,
        bytes32 scopeHash
    ) internal {
        if (facilitator == address(0) || payTo == address(0)) revert ZeroAddress();
        if (cap == 0) revert ZeroAmount();
        if (perOperationCeiling == 0 || perOperationCeiling > cap) revert InvalidCeiling();
        if (validUntil <= block.timestamp) revert InvalidValidUntil();

        uint64 epoch = policy.epoch + 1;
        policy = Policy({
            facilitator: facilitator,
            payTo: payTo,
            cap: cap,
            spent: 0,
            perOperationCeiling: perOperationCeiling,
            validUntil: validUntil,
            epoch: epoch,
            scopeHash: scopeHash,
            revoked: false
        });
        emit PolicyGranted(facilitator, payTo, cap, perOperationCeiling, validUntil, epoch, scopeHash);
    }

    function _sessionGrantStructHash(SessionGrant calldata grant) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SESSION_AUTHORIZATION_TYPEHASH,
                grant.sessionIdHash,
                grant.payerWallet,
                grant.vault,
                grant.facilitator,
                grant.payTo,
                grant.cap,
                grant.perOperationCeiling,
                grant.validUntil,
                grant.asset,
                grant.policyEpoch,
                grant.scopeHash,
                grant.nonce
            )
        );
    }

    /**
     * Immediate because V1 never serves or reserves work before settlement.
     */
    function revoke() external {
        if (msg.sender != payer) revert NotPayer();
        policy.revoked = true;
        emit PolicyRevoked(policy.epoch);
    }

    /**
     * @notice Settles exactly one operation to the policy's immutable payee.
     * @param operationId Canonical operation-binding digest.
     * @param policyEpoch Epoch observed when the session was registered.
     * @param amount Exact micro-USDC amount for this operation.
     */
    function settleOperation(bytes32 operationId, uint64 policyEpoch, uint256 amount) external nonReentrant {
        Policy storage p = policy;
        if (msg.sender != p.facilitator) revert NotFacilitator();
        if (p.revoked) revert PolicyRevokedError();
        if (block.timestamp >= p.validUntil) revert PolicyExpired();
        if (policyEpoch != p.epoch) revert PolicyEpochMismatch();
        if (operationId == bytes32(0)) revert ZeroOperationId();
        if (settledOperations[operationId]) revert OperationAlreadySettled();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.perOperationCeiling) revert OperationCeilingExceeded();
        if (p.spent + amount > p.cap) revert CapExceeded();
        if (_usdc().balanceOf(address(this)) < amount) revert InsufficientFundedBalance();

        settledOperations[operationId] = true;
        p.spent += amount;
        _usdc().safeTransfer(p.payTo, amount);

        emit OperationSettled(operationId, p.payTo, amount, p.spent, p.epoch);
    }

    function available() public view returns (uint256) {
        Policy storage p = policy;
        if (p.revoked || block.timestamp >= p.validUntil || p.cap <= p.spent) return 0;
        uint256 headroom = p.cap - p.spent;
        uint256 balance = _usdc().balanceOf(address(this));
        return balance < headroom ? balance : headroom;
    }

    function withdrawable() public view returns (uint256) {
        uint256 balance = _usdc().balanceOf(address(this));
        uint256 locked = available();
        return balance - locked;
    }

    function withdrawRemainder(uint256 amount) external nonReentrant {
        if (msg.sender != payer) revert NotPayer();
        if (amount == 0) revert ZeroAmount();
        if (amount > withdrawable()) revert InsufficientUnlocked();
        _usdc().safeTransfer(payer, amount);
        emit RemainderWithdrawn(payer, amount);
    }
}
