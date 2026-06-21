// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StakeVaultFactory} from "../../src/rail/StakeVaultFactory.sol";
import {StakeVault} from "../../src/rail/StakeVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract StakeVaultFactoryTest is Test {
    MockUSDC internal usdc;
    StakeVaultFactory internal factory;

    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    event VaultCreated(address indexed payer, address vault);

    function setUp() public {
        usdc = new MockUSDC();
        factory = new StakeVaultFactory(address(usdc));
    }

    function test_Constructor_SetsUsdcAndImpl() public view {
        assertEq(factory.usdc(), address(usdc));
        assertTrue(factory.vaultImpl() != address(0));
    }

    function test_Constructor_RevertsZeroUsdc() public {
        vm.expectRevert(StakeVaultFactory.ZeroAddress.selector);
        new StakeVaultFactory(address(0));
    }

    function test_CreateVault_DeploysAndBinds() public {
        address predicted = factory.computeVaultAddress(payer);

        vm.expectEmit(true, false, false, true);
        emit VaultCreated(payer, predicted);
        address vault = factory.createVault(payer);

        assertEq(vault, predicted, "deployed != predicted");
        assertEq(factory.vaults(payer), vault);

        StakeVault sv = StakeVault(vault);
        assertEq(sv.payer(), payer);
        assertEq(sv.factory(), address(factory));
        assertEq(sv.usdc(), address(usdc));
    }

    function test_CreateVault_AnyoneCanDeployForPayer() public {
        // A stranger triggers deployment, but the vault still binds to `payer`.
        vm.prank(stranger);
        address vault = factory.createVault(payer);
        assertEq(StakeVault(vault).payer(), payer);
    }

    function test_CreateVault_RevertsIfAlreadyCreated() public {
        factory.createVault(payer);
        vm.expectRevert(StakeVaultFactory.AlreadyCreated.selector);
        factory.createVault(payer);
    }

    function test_CreateVault_RevertsZeroAddress() public {
        vm.expectRevert(StakeVaultFactory.ZeroAddress.selector);
        factory.createVault(address(0));
    }

    function test_DifferentPayers_DifferentVaults() public {
        address v1 = factory.createVault(payer);
        address v2 = factory.createVault(stranger);
        assertTrue(v1 != v2);
    }

    function testFuzz_ComputeMatchesDeployed(address who) public {
        vm.assume(who != address(0));
        address predicted = factory.computeVaultAddress(who);
        address vault = factory.createVault(who);
        assertEq(vault, predicted);
    }
}
