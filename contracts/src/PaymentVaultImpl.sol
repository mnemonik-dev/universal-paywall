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
interface IPaymentSplitterFactory {
    function usdc() external view returns (address);
    function feeBps() external view returns (uint16);
    function platformTreasury() external view returns (address);
}

/**
 * @title PaymentVaultImpl
 * @notice Per-developer passive USDC vault deployed as an EIP-1167 minimal
 *         proxy by `PaymentSplitterFactory`. EIP-3009 settlement transfers
 *         USDC directly into this address; the developer later calls
 *         `withdraw()` to receive net proceeds while the platform fee is
 *         routed to `factory.platformTreasury()`.
 * @custom:security-invariant no_selfdestruct no_delegatecall single_initializer no_setters_for_developer_or_factory
 */
contract PaymentVaultImpl is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public developer;
    address public factory;

    event Withdrawal(address indexed developer, uint256 gross, uint256 fee);

    error NotDeveloper();
    error NoBalance();
    error ZeroAddress();

    /// @dev Locks the implementation contract so it can never be initialized
    ///      directly; only EIP-1167 clones produced by the factory may run
    ///      `initialize`. Satisfies D15 (impl lock-down).
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice One-shot initializer invoked by the factory immediately after
     *         `Clones.cloneDeterministic`. `developer` and `factory` are
     *         written exactly once (D17) — there are no setters.
     * @param _developer Developer EOA that owns this vault.
     */
    function initialize(address _developer) external initializer {
        if (_developer == address(0)) revert ZeroAddress();
        developer = _developer;
        factory = msg.sender;
    }

    /**
     * @notice Drains the vault's USDC balance, splitting it between the
     *         developer (net) and the platform treasury (fee).
     * @dev Transfer order is canonical (systemic-fix §7): developer first,
     *      platform second. Pausable on the factory does NOT block this
     *      function (D12) — withdraw is intentionally unpausable.
     */
    function withdraw() external nonReentrant {
        if (msg.sender != developer) revert NotDeveloper();

        IPaymentSplitterFactory f = IPaymentSplitterFactory(factory);
        IERC20 usdc = IERC20(f.usdc());

        uint256 gross = usdc.balanceOf(address(this));
        if (gross == 0) revert NoBalance();

        uint256 feeBps = f.feeBps();
        uint256 fee = (gross * feeBps) / 10000;
        uint256 net = gross - fee;

        usdc.safeTransfer(developer, net);
        if (fee > 0) {
            usdc.safeTransfer(f.platformTreasury(), fee);
        }

        emit Withdrawal(developer, gross, fee);
    }
}
