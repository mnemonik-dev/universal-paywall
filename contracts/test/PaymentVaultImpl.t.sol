// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {PaymentSplitterFactory} from "../src/PaymentSplitterFactory.sol";
import {PaymentVaultImpl} from "../src/PaymentVaultImpl.sol";
import {MockUsdcEip3009} from "./mocks/MockUsdcEip3009.sol";
import {MockUsdcWithHook} from "./mocks/MockUsdcWithHook.sol";
import {MockMaliciousTreasury, IPaymentVaultLike} from "./mocks/MockMaliciousTreasury.sol";

contract PaymentVaultImplTest is Test {
    MockUsdcEip3009 internal mockUsdc;
    PaymentSplitterFactory internal factory;
    PaymentVaultImpl internal vault;
    address internal treasury;
    address internal dev1;

    event Withdrawal(address indexed developer, uint256 gross, uint256 fee);

    function setUp() public {
        mockUsdc = new MockUsdcEip3009();
        treasury = makeAddr("treasury");
        // Iteration-3 §1: 3-arg constructor.
        factory = new PaymentSplitterFactory(IERC20(address(mockUsdc)), treasury, 50);
        dev1 = makeAddr("dev1");
        vm.prank(dev1);
        vault = PaymentVaultImpl(factory.register());
    }

    // ---------------------------------------------------------------
    // Group 1: initialize() single-call
    // ---------------------------------------------------------------

    function test_Initialize_FirstCallSucceeds() public view {
        // setUp() already called factory.register() which calls initialize(dev1).
        // If it had failed, setUp() would have reverted; this assertion pins the
        // post-condition.
        assertEq(vault.developer(), dev1, "vault not initialized with dev1");
        assertEq(vault.factory(), address(factory), "vault.factory mismatch");
    }

    function test_Initialize_RevertsOnSecondCall() public {
        address otherDev = makeAddr("otherDev");
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(otherDev);
    }

    function test_Initialize_RevertsOnZeroDeveloper() public {
        // Manually deploy a fresh clone of the impl (bypassing factory.register
        // which always passes msg.sender) so we can exercise the zero-developer
        // guard inside `initialize`.
        address freshClone = Clones.clone(factory.vaultImpl());
        vm.expectRevert(PaymentVaultImpl.ZeroAddress.selector);
        PaymentVaultImpl(freshClone).initialize(address(0));
    }

    // ---------------------------------------------------------------
    // Group 2: D15 — _disableInitializers() on impl
    // ---------------------------------------------------------------

    function test_D15_DirectInitializeOnImplReverts() public {
        // factory.vaultImpl() is the implementation contract, not a clone.
        // _disableInitializers() in its constructor must block initialize().
        PaymentVaultImpl impl = PaymentVaultImpl(factory.vaultImpl());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(makeAddr("hijacker"));
    }

    // ---------------------------------------------------------------
    // Group 3: D16 — no receive() / fallback()
    // ---------------------------------------------------------------

    function test_D16_NativeTransferReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(vault).call{value: 1}("");
        assertFalse(ok, "vault accepted native ETH - D16 broken");
    }

    // ---------------------------------------------------------------
    // Group 4: D17 — no setDeveloper / setFactory selectors
    // ---------------------------------------------------------------

    function test_D17_NoSetDeveloperSelector() public {
        bytes4 sel = bytes4(keccak256("setDeveloper(address)"));
        (bool ok, ) = address(vault).call(abi.encodeWithSelector(sel, address(0xBEEF)));
        assertFalse(ok, "vault must NOT expose setDeveloper");
    }

    function test_D17_NoSetFactorySelector() public {
        bytes4 sel = bytes4(keccak256("setFactory(address)"));
        (bool ok, ) = address(vault).call(abi.encodeWithSelector(sel, address(0xBEEF)));
        assertFalse(ok, "vault must NOT expose setFactory");
    }

    function test_D17_DeveloperNonZeroAfterInit() public view {
        assertTrue(vault.developer() != address(0), "developer is zero after init");
    }

    // ---------------------------------------------------------------
    // Group 5: withdraw — happy path + access control + zero balance
    // ---------------------------------------------------------------

    function test_Withdraw_RevertsForNonDeveloper() public {
        address notDev = makeAddr("notDev");
        mockUsdc.mint(address(vault), 1000);
        vm.prank(notDev);
        vm.expectRevert(PaymentVaultImpl.NotDeveloper.selector);
        vault.withdraw();
    }

    function test_Withdraw_RevertsOnZeroBalance() public {
        vm.prank(dev1);
        vm.expectRevert(PaymentVaultImpl.NoBalance.selector);
        vault.withdraw();
    }

    function test_Withdraw_HappyPathDeveloperFirst() public {
        uint256 gross = 1000; // micro-USDC
        // factory.feeBps() == 50 (set in setUp).
        mockUsdc.mint(address(vault), gross);

        uint256 devBalBefore = mockUsdc.balanceOf(dev1);
        uint256 treasuryBalBefore = mockUsdc.balanceOf(treasury);

        vm.expectEmit(true, false, false, true, address(vault));
        emit Withdrawal(dev1, 1000, 5);

        vm.prank(dev1);
        vault.withdraw();

        // Transfer-order pin (systemic-fix §7): developer first, treasury second.
        // The order itself cannot be directly observed off-chain (post-tx state
        // is identical), but the reentrancy test below exercises the order
        // dynamically by pointing treasury at MockMaliciousTreasury.
        assertEq(mockUsdc.balanceOf(dev1) - devBalBefore, 995, "dev net");
        assertEq(mockUsdc.balanceOf(treasury) - treasuryBalBefore, 5, "treasury fee");
        assertEq(mockUsdc.balanceOf(address(vault)), 0, "vault not drained");
    }

    // ---------------------------------------------------------------
    // Group 6: Fee edge cases
    // ---------------------------------------------------------------

    function test_Withdraw_FeeBps0_NoSecondTransfer() public {
        factory.setFeeBps(0);
        mockUsdc.mint(address(vault), 1000);
        uint256 treasuryBalBefore = mockUsdc.balanceOf(treasury);
        vm.prank(dev1);
        vault.withdraw();
        assertEq(mockUsdc.balanceOf(dev1), 1000, "dev did not get gross");
        assertEq(mockUsdc.balanceOf(treasury), treasuryBalBefore, "treasury changed on 0 fee");
        assertEq(mockUsdc.balanceOf(address(vault)), 0);
    }

    function test_Withdraw_FeeBps1000_Splits90_10() public {
        factory.setFeeBps(1000);
        mockUsdc.mint(address(vault), 1000);
        vm.prank(dev1);
        vault.withdraw();
        assertEq(mockUsdc.balanceOf(dev1), 900, "dev got != 900");
        assertEq(mockUsdc.balanceOf(treasury), 100, "treasury got != 100");
        assertEq(mockUsdc.balanceOf(address(vault)), 0);
    }

    function test_Withdraw_DustGrossTruncatesFee() public {
        mockUsdc.mint(address(vault), 1);
        vm.prank(dev1);
        vault.withdraw();
        assertEq(mockUsdc.balanceOf(dev1), 1, "dev did not get 1 dust unit");
        assertEq(mockUsdc.balanceOf(treasury), 0, "treasury got dust fee");
        assertEq(mockUsdc.balanceOf(address(vault)), 0);
    }

    function test_Withdraw_Boundary199() public {
        mockUsdc.mint(address(vault), 199);
        vm.prank(dev1);
        vault.withdraw();
        // fee = floor(199 * 50 / 10000) = 0
        assertEq(mockUsdc.balanceOf(dev1), 199, "dev != 199");
        assertEq(mockUsdc.balanceOf(treasury), 0, "treasury fee on 199");
    }

    function test_Withdraw_Boundary200() public {
        mockUsdc.mint(address(vault), 200);
        vm.prank(dev1);
        vault.withdraw();
        // fee = floor(200 * 50 / 10000) = 1
        assertEq(mockUsdc.balanceOf(dev1), 199, "dev != 199");
        assertEq(mockUsdc.balanceOf(treasury), 1, "treasury != 1");
    }

    // ---------------------------------------------------------------
    // Group 7: Fee-snapshot semantics
    // ---------------------------------------------------------------

    /// @dev Pins current behavior: feeBps is read from the factory at
    ///      withdraw time, not snapshotted per payment. If a future refactor
    ///      changes this to per-payment snapshot, this test will fail loudly.
    function test_Withdraw_UsesCurrentFeeBpsAtWithdrawTime() public {
        // feeBps starts at 50.
        mockUsdc.mint(address(vault), 1000);
        // Owner bumps fee to 100 BEFORE any withdraw.
        factory.setFeeBps(100);
        // Vault accumulates more funds — both at "old" and "new" rate.
        mockUsdc.mint(address(vault), 1000);
        // Now developer withdraws against gross = 2000 at fee = 100.
        vm.prank(dev1);
        vault.withdraw();
        // 2000 * 100 / 10000 = 20.
        assertEq(mockUsdc.balanceOf(dev1), 1980, "dev != 1980");
        assertEq(mockUsdc.balanceOf(treasury), 20, "treasury != 20");
    }

    // ---------------------------------------------------------------
    // Group 8: Dynamic reentrancy via MockMaliciousTreasury
    // ---------------------------------------------------------------

    function test_Withdraw_ReentrancyBlocked_ViaMaliciousTreasury() public {
        // Build an isolated harness with the hook-enabled USDC + malicious
        // treasury so we don't have to retrofit the shared mockUsdc.
        MockUsdcWithHook hookedUsdc = new MockUsdcWithHook();
        MockMaliciousTreasury malicious = new MockMaliciousTreasury();

        PaymentSplitterFactory hostileFactory =
            new PaymentSplitterFactory(IERC20(address(hookedUsdc)), address(malicious), 50);

        address dev = makeAddr("hostileDev");
        vm.prank(dev);
        PaymentVaultImpl hostileVault = PaymentVaultImpl(hostileFactory.register());

        malicious.setTarget(IPaymentVaultLike(address(hostileVault)));

        // Fund vault BEFORE enabling hooks (so mint to vault does not callback).
        hookedUsdc.mint(address(hostileVault), 1000);
        hookedUsdc.setHooksEnabled(true);

        uint256 vaultBalBefore = hookedUsdc.balanceOf(address(hostileVault));

        // Re-entry blocked by OZ ReentrancyGuard. The revert from the inner
        // withdraw() bubbles up through the hook → fee safeTransfer → outer
        // withdraw(), so the developer-first transfer is also rolled back.
        vm.prank(dev);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hostileVault.withdraw();

        // The whole outer call reverted, so all state — including the
        // developer-first transfer — was rolled back. The expected revert
        // selector itself proves the re-entry hit `nonReentrant`; the asserts
        // below pin the rollback completeness.
        assertEq(hookedUsdc.balanceOf(address(hostileVault)), vaultBalBefore, "vault state changed after reentrancy revert");
        assertEq(hookedUsdc.balanceOf(dev), 0, "dev got funds despite revert");
    }

    // ---------------------------------------------------------------
    // Group 9: Withdraw works when factory paused
    // ---------------------------------------------------------------

    function test_Withdraw_WorksWhenFactoryPaused() public {
        mockUsdc.mint(address(vault), 1000);
        factory.pause();
        vm.prank(dev1);
        vault.withdraw();
        assertEq(mockUsdc.balanceOf(dev1), 995, "dev did not get net while paused");
        assertEq(mockUsdc.balanceOf(treasury), 5, "treasury did not get fee while paused");
    }

    // ---------------------------------------------------------------
    // Fuzz: fee math
    // ---------------------------------------------------------------

    function testFuzz_FeeMath(uint256 gross, uint16 feeBps) public {
        gross = bound(gross, 1, 1e18);
        feeBps = uint16(bound(uint256(feeBps), 0, 1000));

        factory.setFeeBps(feeBps);
        mockUsdc.mint(address(vault), gross);

        uint256 devBalBefore = mockUsdc.balanceOf(dev1);
        uint256 treasuryBalBefore = mockUsdc.balanceOf(treasury);

        vm.prank(dev1);
        vault.withdraw();

        uint256 fee = (gross * feeBps) / 10000;
        uint256 net = gross - fee;

        assertEq(mockUsdc.balanceOf(dev1) - devBalBefore, net, "dev net mismatch");
        assertEq(mockUsdc.balanceOf(treasury) - treasuryBalBefore, fee, "treasury fee mismatch");
        assertEq(net + fee, gross, "split sum != gross");
        assertLe(fee, gross, "fee exceeds gross");
        assertEq(mockUsdc.balanceOf(address(vault)), 0, "vault not drained");
    }
}
