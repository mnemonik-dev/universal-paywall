// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StakeVaultFactory} from "../../src/rail/StakeVaultFactory.sol";
import {StakeVault} from "../../src/rail/StakeVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract StakeVaultTest is Test {
    MockUSDC internal usdc;
    StakeVaultFactory internal factory;
    StakeVault internal vault;

    address internal payer = makeAddr("payer");
    address internal facilitator = makeAddr("facilitator");
    address internal creatorA = makeAddr("creatorA");
    address internal creatorB = makeAddr("creatorB");

    uint256 internal constant STAKE = 1_000_000; // 1 USDC (6 decimals)
    uint256 internal constant CAP = 600_000; // 0.6 USDC
    uint64 internal validUntil;

    event Deposited(address indexed from, uint256 amount);
    event PolicyGranted(address indexed facilitator, uint256 cap, uint64 validUntil, uint64 epoch);
    event PolicyRevoked(uint64 validUntil, uint64 epoch);
    event Settled(address indexed facilitator, uint256 total, uint256 count, uint256 spent);
    event RemainderWithdrawn(address indexed payer, uint256 amount);

    function setUp() public {
        usdc = new MockUSDC();
        factory = new StakeVaultFactory(address(usdc));
        vault = StakeVault(factory.createVault(payer));
        validUntil = uint64(block.timestamp + 1 days);

        usdc.mint(payer, STAKE);
        vm.startPrank(payer);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(STAKE);
        vm.stopPrank();
    }

    function _grant() internal {
        vm.prank(payer);
        vault.grantPolicy(facilitator, CAP, validUntil);
    }

    function _settle(address creator, uint256 amount) internal {
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creator;
        a[0] = amount;
        vm.prank(facilitator);
        vault.settle(c, a);
    }

    // ----- deposit -----

    function test_Deposit_PullsFunds() public view {
        assertEq(usdc.balanceOf(address(vault)), STAKE);
    }

    function test_Deposit_RevertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_Deposit_AnyoneCanFund() public {
        address benefactor = makeAddr("benefactor");
        usdc.mint(benefactor, 500_000);
        vm.startPrank(benefactor);
        usdc.approve(address(vault), 500_000);
        vm.expectEmit(true, false, false, true);
        emit Deposited(benefactor, 500_000);
        vault.deposit(500_000);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), STAKE + 500_000);
    }

    // ----- grantPolicy -----

    function test_GrantPolicy_SetsPolicy() public {
        vm.expectEmit(true, false, false, true);
        emit PolicyGranted(facilitator, CAP, validUntil, 1);
        _grant();

        (address f, uint256 cap, uint256 spent, uint64 vu, uint64 epoch) = vault.policy();
        assertEq(f, facilitator);
        assertEq(cap, CAP);
        assertEq(spent, 0);
        assertEq(vu, validUntil);
        assertEq(epoch, 1);
    }

    function test_GrantPolicy_RevertsNotPayer() public {
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.NotPayer.selector);
        vault.grantPolicy(facilitator, CAP, validUntil);
    }

    function test_GrantPolicy_RevertsZeroFacilitator() public {
        vm.prank(payer);
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.grantPolicy(address(0), CAP, validUntil);
    }

    function test_GrantPolicy_RevertsZeroCap() public {
        vm.prank(payer);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vault.grantPolicy(facilitator, 0, validUntil);
    }

    function test_GrantPolicy_RevertsPastDeadline() public {
        vm.prank(payer);
        vm.expectRevert(StakeVault.InvalidValidUntil.selector);
        vault.grantPolicy(facilitator, CAP, uint64(block.timestamp));
    }

    function test_GrantPolicy_SupersedesAndResetsSpent() public {
        _grant();
        _settle(creatorA, 100_000);
        (, , uint256 spent1, , uint64 epoch1) = vault.policy();
        assertEq(spent1, 100_000);
        assertEq(epoch1, 1);

        // Re-grant: spent resets, epoch increments.
        vm.prank(payer);
        vault.grantPolicy(facilitator, CAP, validUntil);
        (, , uint256 spent2, , uint64 epoch2) = vault.policy();
        assertEq(spent2, 0);
        assertEq(epoch2, 2);
    }

    // ----- settle -----

    function test_Settle_SingleCreator() public {
        _grant();
        vm.expectEmit(true, false, false, true);
        emit Settled(facilitator, 100_000, 1, 100_000);
        _settle(creatorA, 100_000);

        assertEq(usdc.balanceOf(creatorA), 100_000);
        assertEq(usdc.balanceOf(address(vault)), STAKE - 100_000);
        (, , uint256 spent, , ) = vault.policy();
        assertEq(spent, 100_000);
    }

    function test_Settle_BatchedMultipleCreators() public {
        _grant();
        address[] memory c = new address[](2);
        uint256[] memory a = new uint256[](2);
        c[0] = creatorA;
        c[1] = creatorB;
        a[0] = 100_000;
        a[1] = 250_000;

        vm.prank(facilitator);
        vault.settle(c, a);

        assertEq(usdc.balanceOf(creatorA), 100_000);
        assertEq(usdc.balanceOf(creatorB), 250_000);
        (, , uint256 spent, , ) = vault.policy();
        assertEq(spent, 350_000);
    }

    function test_Settle_AccumulatesSpentAcrossCalls() public {
        _grant();
        _settle(creatorA, 200_000);
        _settle(creatorB, 200_000);
        (, , uint256 spent, , ) = vault.policy();
        assertEq(spent, 400_000);
    }

    function test_Settle_RevertsNotFacilitator() public {
        _grant();
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = 1;
        vm.prank(payer); // payer is not the facilitator
        vm.expectRevert(StakeVault.NotFacilitator.selector);
        vault.settle(c, a);
    }

    function test_Settle_RevertsPolicyExpired() public {
        _grant();
        vm.warp(uint256(validUntil) + 1);
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = 1;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.PolicyExpired.selector);
        vault.settle(c, a);
    }

    function test_Settle_RevertsCapExceeded() public {
        _grant();
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = CAP + 1;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.CapExceeded.selector);
        vault.settle(c, a);
    }

    function test_Settle_RevertsLengthMismatch() public {
        _grant();
        address[] memory c = new address[](2);
        uint256[] memory a = new uint256[](1);
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.LengthMismatch.selector);
        vault.settle(c, a);
    }

    function test_Settle_RevertsZeroAmountEntry() public {
        _grant();
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = 0;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vault.settle(c, a);
    }

    function test_Settle_RevertsZeroAddressCreator() public {
        _grant();
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = address(0);
        a[0] = 1;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.settle(c, a);
    }

    // ----- encumbered / withdrawable -----

    function test_Encumbered_WhileActive() public {
        _grant();
        assertEq(vault.encumbered(), CAP);
        _settle(creatorA, 100_000);
        assertEq(vault.encumbered(), CAP - 100_000);
    }

    function test_Encumbered_ZeroAfterExpiry() public {
        _grant();
        vm.warp(uint256(validUntil) + 1);
        assertEq(vault.encumbered(), 0);
    }

    function test_Withdrawable_ExcludesEncumbered() public {
        _grant();
        // balance STAKE, encumbered CAP → withdrawable = STAKE - CAP
        assertEq(vault.withdrawable(), STAKE - CAP);
        _settle(creatorA, 100_000);
        // balance STAKE-100k, encumbered CAP-100k → withdrawable still STAKE-CAP
        assertEq(vault.withdrawable(), STAKE - CAP);
    }

    // ----- withdrawRemainder -----

    function test_WithdrawRemainder_OnlyUnencumbered() public {
        _grant();
        vm.prank(payer);
        vault.withdrawRemainder(STAKE - CAP);
        assertEq(usdc.balanceOf(payer), STAKE - CAP);
        assertEq(vault.withdrawable(), 0);
    }

    function test_WithdrawRemainder_RevertsOverEncumbered() public {
        _grant();
        vm.prank(payer);
        vm.expectRevert(StakeVault.InsufficientUnlocked.selector);
        vault.withdrawRemainder(STAKE - CAP + 1);
    }

    function test_WithdrawRemainder_RevertsNotPayer() public {
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.NotPayer.selector);
        vault.withdrawRemainder(1);
    }

    function test_WithdrawRemainder_RevertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vault.withdrawRemainder(0);
    }

    function test_WithdrawRemainder_AllAfterExpiry() public {
        _grant();
        _settle(creatorA, 100_000); // spent 100k, balance 900k
        vm.warp(uint256(validUntil) + 1); // policy expired → nothing encumbered
        vm.prank(payer);
        vault.withdrawRemainder(STAKE - 100_000);
        assertEq(usdc.balanceOf(payer), STAKE - 100_000);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ----- revoke -----

    function test_Revoke_ShortensValidUntil() public {
        _grant();
        vm.prank(payer);
        vault.revoke();
        (, , , uint64 vu, ) = vault.policy();
        assertEq(vu, uint64(block.timestamp) + vault.REVOKE_COOLDOWN());
    }

    function test_Revoke_OnlyPayer() public {
        _grant();
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.NotPayer.selector);
        vault.revoke();
    }

    function test_Revoke_GivesFacilitatorCooldownWindow() public {
        _grant();
        vm.prank(payer);
        vault.revoke();

        // Within cooldown: facilitator can still settle served charges.
        _settle(creatorA, 50_000);
        assertEq(usdc.balanceOf(creatorA), 50_000);

        // After cooldown: settle reverts, payer reclaims everything.
        vm.warp(block.timestamp + vault.REVOKE_COOLDOWN() + 1);
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = 1;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.PolicyExpired.selector);
        vault.settle(c, a);

        assertEq(vault.withdrawable(), STAKE - 50_000);
    }

    // ----- non-custodial property -----

    function test_NonCustodial_FacilitatorCannotExceedCap() public {
        _grant();
        // Even if the facilitator settles to itself, it is bounded by cap.
        _settle(facilitator, CAP);
        assertEq(usdc.balanceOf(facilitator), CAP);

        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = facilitator;
        a[0] = 1;
        vm.prank(facilitator);
        vm.expectRevert(StakeVault.CapExceeded.selector);
        vault.settle(c, a);

        // Payer always reclaims the rest.
        vm.prank(payer);
        vault.withdrawRemainder(STAKE - CAP);
        assertEq(usdc.balanceOf(payer), STAKE - CAP);
    }

    function testFuzz_SettleNeverExceedsCap(uint256 amount) public {
        _grant();
        amount = bound(amount, 1, STAKE);
        address[] memory c = new address[](1);
        uint256[] memory a = new uint256[](1);
        c[0] = creatorA;
        a[0] = amount;
        vm.prank(facilitator);
        if (amount > CAP) {
            vm.expectRevert(StakeVault.CapExceeded.selector);
            vault.settle(c, a);
        } else {
            vault.settle(c, a);
            assertEq(usdc.balanceOf(creatorA), amount);
            (, , uint256 spent, , ) = vault.policy();
            assertLe(spent, CAP);
        }
    }
}
