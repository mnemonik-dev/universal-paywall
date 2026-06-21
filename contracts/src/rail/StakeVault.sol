// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Minimal view-surface of the parent factory consumed by the vault.
 *      Declared inline to avoid a circular import between vault and factory.
 */
interface IStakeVaultFactory {
    function usdc() external view returns (address);
}

/**
 * @title StakeVault
 * @notice Per-payer, non-custodial prepaid stake. The payer deposits USDC and
 *         grants a single facilitator a bounded, revocable spending policy
 *         (`{cap, validUntil}`). The facilitator settles batches of charges
 *         directly to creator addresses against the locked stake; the payer
 *         reclaims the unencumbered remainder at any time, and everything once
 *         the policy expires.
 *
 *         Deployed as an EIP-1167 minimal proxy by `StakeVaultFactory`. There
 *         is no platform fee, no owner, and no pause — the rail is a neutral
 *         public good. The only privileged parties are the `payer` (their own
 *         funds) and the policy `facilitator` (bounded by `cap`/`validUntil`).
 * @custom:security-invariant non_custodial facilitator_bounded_by_cap payer_reclaims_remainder no_owner no_fee
 */
contract StakeVault is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice On `revoke()`, the facilitator keeps at most this window to
    ///         settle already-served charges before the encumbered stake
    ///         unlocks for the payer.
    uint64 public constant REVOKE_COOLDOWN = 1 hours;

    address public payer;
    address public factory;

    struct Policy {
        address facilitator; // delegated settler ("session key" holder)
        uint256 cap; // max total settleable under this policy (micro-USDC)
        uint256 spent; // settled so far under the active policy
        uint64 validUntil; // settlement deadline (unix seconds)
        uint64 epoch; // bumped on each grant; invalidates superseded policies
    }

    Policy public policy;

    event Deposited(address indexed from, uint256 amount);
    event PolicyGranted(address indexed facilitator, uint256 cap, uint64 validUntil, uint64 epoch);
    event PolicyRevoked(uint64 validUntil, uint64 epoch);
    event Settled(address indexed facilitator, uint256 total, uint256 count, uint256 spent);
    event RemainderWithdrawn(address indexed payer, uint256 amount);

    error NotPayer();
    error NotFacilitator();
    error PolicyExpired();
    error CapExceeded();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidValidUntil();
    error LengthMismatch();
    error InsufficientUnlocked();

    /// @dev Locks the implementation so only factory-produced clones initialize.
    ///      EIP-1167 clones skip this constructor, so `ReentrancyGuard._status`
    ///      starts at 0 on a clone; the guard only reverts on `_status == ENTERED
    ///      (2)`, so the zero-default passes the entry check (same pattern as the
    ///      repo's PaymentVaultImpl).
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice One-shot initializer invoked by the factory immediately after the
     *         deterministic clone is created. `payer` and `factory` are written
     *         exactly once — there are no setters.
     */
    function initialize(address _payer) external initializer {
        if (_payer == address(0)) revert ZeroAddress();
        payer = _payer;
        factory = msg.sender;
    }

    function _usdc() internal view returns (IERC20) {
        return IERC20(IStakeVaultFactory(factory).usdc());
    }

    /// @notice Convenience view of the USDC token this vault settles in.
    function usdc() external view returns (address) {
        return address(_usdc());
    }

    /**
     * @notice Pull `amount` USDC from `msg.sender` into the vault. Requires a
     *         prior ERC-20 approval. Anyone may fund a payer's vault; the funds
     *         are controlled solely by `payer` thereafter.
     */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _usdc().safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Payer authorizes `facilitator` to settle up to `cap` until
     *         `validUntil`. Granting supersedes any prior policy: `spent` resets
     *         and `epoch` increments, so a previously-authorized facilitator can
     *         no longer settle.
     */
    function grantPolicy(address facilitator, uint256 cap, uint64 validUntil) external {
        if (msg.sender != payer) revert NotPayer();
        if (facilitator == address(0)) revert ZeroAddress();
        if (cap == 0) revert ZeroAmount();
        if (validUntil <= block.timestamp) revert InvalidValidUntil();

        uint64 epoch = policy.epoch + 1;
        policy = Policy({facilitator: facilitator, cap: cap, spent: 0, validUntil: validUntil, epoch: epoch});
        emit PolicyGranted(facilitator, cap, validUntil, epoch);
    }

    /**
     * @notice Payer revokes the active policy. `validUntil` is shortened to at
     *         most `now + REVOKE_COOLDOWN` (never extended), giving the
     *         facilitator a bounded window to settle already-served charges.
     */
    function revoke() external {
        if (msg.sender != payer) revert NotPayer();
        uint64 cutoff = uint64(block.timestamp) + REVOKE_COOLDOWN;
        if (cutoff < policy.validUntil) {
            policy.validUntil = cutoff;
        }
        emit PolicyRevoked(policy.validUntil, policy.epoch);
    }

    /**
     * @notice Facilitator settles a batch of charges. Each `creators[i]` receives
     *         `amounts[i]` USDC directly from the locked stake. Authorized only
     *         for the active policy's facilitator, only before `validUntil`, and
     *         only while cumulative `spent` stays within `cap`.
     * @dev Checks-effects-interactions: `spent` is updated before any transfer,
     *      and the whole call is `nonReentrant`.
     */
    function settle(address[] calldata creators, uint256[] calldata amounts) external nonReentrant {
        Policy storage p = policy;
        if (msg.sender != p.facilitator) revert NotFacilitator();
        if (block.timestamp > p.validUntil) revert PolicyExpired();
        if (creators.length != amounts.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] == 0) revert ZeroAmount();
            if (creators[i] == address(0)) revert ZeroAddress();
            total += amounts[i];
        }
        if (total == 0) revert ZeroAmount();
        if (p.spent + total > p.cap) revert CapExceeded();

        p.spent += total;

        IERC20 token = _usdc();
        for (uint256 i; i < creators.length; ++i) {
            token.safeTransfer(creators[i], amounts[i]);
        }

        emit Settled(msg.sender, total, creators.length, p.spent);
    }

    /// @notice USDC reserved for the active policy's facilitator (locked).
    function encumbered() public view returns (uint256) {
        Policy storage p = policy;
        if (block.timestamp > p.validUntil) return 0;
        return p.cap - p.spent;
    }

    /// @notice USDC the payer may withdraw right now (balance minus encumbered).
    function withdrawable() public view returns (uint256) {
        uint256 bal = _usdc().balanceOf(address(this));
        uint256 enc = encumbered();
        return bal > enc ? bal - enc : 0;
    }

    /// @notice Payer withdraws up to `withdrawable()`.
    function withdrawRemainder(uint256 amount) external nonReentrant {
        if (msg.sender != payer) revert NotPayer();
        if (amount == 0) revert ZeroAmount();
        if (amount > withdrawable()) revert InsufficientUnlocked();
        _usdc().safeTransfer(payer, amount);
        emit RemainderWithdrawn(payer, amount);
    }
}
