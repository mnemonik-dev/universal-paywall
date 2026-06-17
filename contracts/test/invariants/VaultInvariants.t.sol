// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PaymentSplitterFactory} from "../../src/PaymentSplitterFactory.sol";
import {PaymentVaultImpl} from "../../src/PaymentVaultImpl.sol";
import {MockUsdcEip3009} from "../mocks/MockUsdcEip3009.sol";

/**
 * @dev Stateful fuzzing handler. Every public function bounds its inputs so
 *      the Foundry invariant runner spends its budget on reachable states
 *      instead of trivially-reverting calls. The handler tracks `totalMinted`
 *      and `totalWithdrawn` so the integrity invariant has an authoritative
 *      reference to compare the vault balance against.
 */
contract VaultHandler is Test {
    MockUsdcEip3009 public mockUsdc;
    PaymentVaultImpl public vault;
    PaymentSplitterFactory public factory;
    address public dev1;
    address public factoryOwner;

    uint256 public totalMinted;
    uint256 public totalWithdrawn;

    constructor(
        MockUsdcEip3009 _mockUsdc,
        PaymentVaultImpl _vault,
        PaymentSplitterFactory _factory,
        address _dev1,
        address _factoryOwner
    ) {
        mockUsdc = _mockUsdc;
        vault = _vault;
        factory = _factory;
        dev1 = _dev1;
        factoryOwner = _factoryOwner;
    }

    function depositToVault(uint256 amount) external {
        amount = bound(amount, 1, 1e18);
        mockUsdc.mint(address(vault), amount);
        totalMinted += amount;
    }

    function withdrawFromVault() external {
        // We track gross (the vault's pre-withdraw balance), not net-to-dev,
        // because the integrity invariant compares `mockUsdc.balanceOf(vault)`
        // against `totalMinted - totalWithdrawn`. Both fee + net leave the
        // vault during withdraw, so `gross` is the right accounting unit.
        uint256 balBefore = mockUsdc.balanceOf(address(vault));
        if (balBefore == 0) return;
        vm.prank(dev1);
        vault.withdraw();
        totalWithdrawn += balBefore;
    }

    function setFeeBps(uint16 bps) external {
        bps = uint16(bound(uint256(bps), 0, 1000));
        vm.prank(factoryOwner);
        factory.setFeeBps(bps);
    }
}

contract VaultInvariantsTest is Test {
    MockUsdcEip3009 internal mockUsdc;
    PaymentSplitterFactory internal factory;
    PaymentVaultImpl internal vault;
    address internal treasury;
    address internal dev1;
    VaultHandler internal handler;

    function setUp() public {
        mockUsdc = new MockUsdcEip3009();
        treasury = makeAddr("treasury");
        // 3-arg constructor (iteration-3 §1). Test contract is owner.
        factory = new PaymentSplitterFactory(IERC20(address(mockUsdc)), treasury, 50);
        dev1 = makeAddr("dev1");
        vm.prank(dev1);
        vault = PaymentVaultImpl(factory.register());

        handler = new VaultHandler(mockUsdc, vault, factory, dev1, address(this));

        // Limit the fuzzer to handler entry points so it cannot, for example,
        // call factory.setPlatformTreasury or vault.initialize with random inputs.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = VaultHandler.depositToVault.selector;
        selectors[1] = VaultHandler.withdrawFromVault.selector;
        selectors[2] = VaultHandler.setFeeBps.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Vault USDC balance == sum(mints to vault) - sum(withdrawals from vault).
    function invariant_VaultBalanceIntegrity() public view {
        assertEq(
            mockUsdc.balanceOf(address(vault)),
            handler.totalMinted() - handler.totalWithdrawn(),
            "vault balance integrity violated"
        );
    }

    /// @dev Factory feeBps must always remain within the documented 1000 bps cap.
    function invariant_FeeBpsBounded() public view {
        assertLe(factory.feeBps(), 1000, "feeBps exceeded 1000 cap");
    }

    /// @dev Vault developer is never zero once initialize() has run.
    function invariant_DeveloperNonZero() public view {
        assertTrue(vault.developer() != address(0), "vault developer is zero");
    }
}
