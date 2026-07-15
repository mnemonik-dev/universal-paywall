// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SessionStakeVaultFactory} from "../../src/rail/SessionStakeVaultFactory.sol";
import {SessionStakeVault} from "../../src/rail/SessionStakeVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract SessionStakeVaultTest is Test {
    MockUSDC internal usdc;
    SessionStakeVaultFactory internal factory;
    SessionStakeVault internal vault;

    address internal payer = makeAddr("payer");
    address internal facilitator = makeAddr("facilitator");
    address internal payTo = makeAddr("mnemonic");
    address internal other = makeAddr("other");
    uint64 internal validUntil;
    bytes32 internal constant SCOPE_HASH = keccak256("workspace:manual");
    bytes32 internal constant OPERATION = keccak256("operation-1");
    uint256 internal payerKey;

    function setUp() public {
        payerKey = 0xA11CE;
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        factory = new SessionStakeVaultFactory(address(usdc));
        vault = SessionStakeVault(factory.createVault(payer));
        validUntil = uint64(block.timestamp + 7 days);
        usdc.mint(payer, 5_000_000);
        vm.startPrank(payer);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(5_000_000);
        vault.grantPolicy(facilitator, payTo, 4_000_000, 100_000, validUntil, SCOPE_HASH);
        vm.stopPrank();
    }

    function test_GrantPolicyBySig_UsesOneTypedAuthorizationAndRejectsReplay() public {
        address secondPayer = vm.addr(0xB0B);
        SessionStakeVault secondVault = SessionStakeVault(factory.createVault(secondPayer));
        usdc.mint(address(secondVault), 1_000_000);
        SessionStakeVault.SessionGrant memory grant = SessionStakeVault.SessionGrant({
            sessionIdHash: keccak256("session-1"),
            payerWallet: secondPayer,
            vault: address(secondVault),
            facilitator: facilitator,
            payTo: payTo,
            cap: 1_000_000,
            perOperationCeiling: 50_000,
            validUntil: validUntil,
            asset: address(usdc),
            policyEpoch: 1,
            scopeHash: keccak256("mnemonic-session-scope"),
            nonce: keccak256("session-nonce")
        });
        bytes32 digest = secondVault.hashSessionGrant(grant);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(other);
        secondVault.grantPolicyBySig(grant, signature);
        (address policyFacilitator, address policyPayTo, uint256 cap,,,, uint64 epoch,,) = secondVault.policy();
        assertEq(policyFacilitator, facilitator);
        assertEq(policyPayTo, payTo);
        assertEq(cap, 1_000_000);
        assertEq(epoch, 1);

        vm.expectRevert(SessionStakeVault.PolicyEpochMismatch.selector);
        secondVault.grantPolicyBySig(grant, signature);
    }

    function test_SettlesOnceToFixedPayee() public {
        vm.prank(facilitator);
        vault.settleOperation(OPERATION, 1, 50_000);
        assertEq(usdc.balanceOf(payTo), 50_000);
        assertEq(usdc.balanceOf(other), 0);
        assertTrue(vault.settledOperations(OPERATION));

        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.OperationAlreadySettled.selector);
        vault.settleOperation(OPERATION, 1, 50_000);
    }

    function test_EnforcesCeilingCapEpochAndFundedBalance() public {
        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.OperationCeilingExceeded.selector);
        vault.settleOperation(keccak256("ceiling"), 1, 100_001);

        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.PolicyEpochMismatch.selector);
        vault.settleOperation(keccak256("epoch"), 2, 1);

        vm.prank(payer);
        vault.grantPolicy(facilitator, payTo, 10_000_000, 10_000_000, validUntil, SCOPE_HASH);
        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.InsufficientFundedBalance.selector);
        vault.settleOperation(keccak256("balance"), 2, 5_000_001);
    }

    function test_RevokeIsImmediate() public {
        vm.prank(payer);
        vault.revoke();
        assertEq(vault.available(), 0);
        assertEq(vault.withdrawable(), 5_000_000);

        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.PolicyRevokedError.selector);
        vault.settleOperation(OPERATION, 1, 1);
    }

    function test_RegrantInvalidatesOldEpochAndPreservesOperationReplayGuard() public {
        vm.prank(facilitator);
        vault.settleOperation(OPERATION, 1, 10_000);

        vm.prank(payer);
        vault.grantPolicy(facilitator, payTo, 1_000_000, 100_000, validUntil, SCOPE_HASH);

        vm.prank(facilitator);
        vm.expectRevert(SessionStakeVault.OperationAlreadySettled.selector);
        vault.settleOperation(OPERATION, 2, 10_000);
    }

    function test_OnlyPayerCanGrantAndOnlyFacilitatorCanSettle() public {
        vm.prank(other);
        vm.expectRevert(SessionStakeVault.NotPayer.selector);
        vault.grantPolicy(facilitator, payTo, 1, 1, validUntil, SCOPE_HASH);

        vm.prank(other);
        vm.expectRevert(SessionStakeVault.NotFacilitator.selector);
        vault.settleOperation(OPERATION, 1, 1);
    }

    function test_FactoryAddressMatchesDeployment() public view {
        assertEq(factory.vaults(payer), address(vault));
        assertEq(factory.computeVaultAddress(payer), address(vault));
        assertEq(vault.payer(), payer);
        assertEq(vault.usdc(), address(usdc));
    }
}
