// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PaymentSplitterFactory} from "../src/PaymentSplitterFactory.sol";
import {PaymentVaultImpl} from "../src/PaymentVaultImpl.sol";
import {MockUsdcEip3009} from "./mocks/MockUsdcEip3009.sol";

/// @dev Reentrancy in `register()` is structurally impossible: the function
///      writes state before any external call, and the only external call —
///      `PaymentVaultImpl(vault).initialize(msg.sender)` — does not touch the
///      developer EOA or trigger any callbacks. The invariant is pinned by
///      the NatSpec on `register()` (Task 4) and enforced in CI via
///      `slither --detect reentrancy-eth,reentrancy-no-eth` (addendum §1).
///      No dynamic test is necessary or possible here.
contract PaymentSplitterFactoryTest is Test {
    MockUsdcEip3009 internal mockUsdc;
    PaymentSplitterFactory internal factory;
    address internal treasury;
    address internal dev1;
    address internal dev2;
    address internal dev3;

    // Mirrors of factory events for vm.expectEmit declarations. KEEP IN SYNC
    // with the canonical declarations in src/PaymentSplitterFactory.sol — if a
    // signature drifts, the expectEmit assertions silently match the wrong
    // topic and the test passes incorrectly.
    event VaultDeployed(address indexed developer, address vault);
    event FeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);

    function setUp() public {
        mockUsdc = new MockUsdcEip3009();
        treasury = makeAddr("treasury");
        // Iteration-3 §1: exactly 3 constructor args. The factory deploys
        // PaymentVaultImpl internally; we never pass a vaultImpl address.
        factory = new PaymentSplitterFactory(IERC20(address(mockUsdc)), treasury, 50);
        dev1 = makeAddr("dev1");
        dev2 = makeAddr("dev2");
        dev3 = makeAddr("dev3");
    }

    // ---------------------------------------------------------------
    // Group 1: register() happy path + idempotency + pause integration
    // ---------------------------------------------------------------

    function test_Register_DeploysVaultAtPredictedAddress() public {
        address predicted = factory.computeVaultAddress(dev1);
        vm.prank(dev1);
        address deployed = factory.register();
        assertEq(deployed, predicted, "register() returned non-predicted address");
    }

    function test_Register_PopulatesVaultsMapping() public {
        vm.prank(dev1);
        address deployed = factory.register();
        assertEq(factory.vaults(dev1), deployed, "vaults[dev1] mismatch");
        assertTrue(deployed != address(0), "vault address zero");
    }

    function test_Register_VaultInitializedWithDeveloper() public {
        vm.prank(dev1);
        address vault = factory.register();
        assertEq(PaymentVaultImpl(vault).developer(), dev1, "vault.developer != register caller");
        assertEq(PaymentVaultImpl(vault).factory(), address(factory), "vault.factory != factory");
    }

    function test_Register_RevertsAlreadyRegistered() public {
        vm.prank(dev1);
        factory.register();
        vm.prank(dev1);
        vm.expectRevert(PaymentSplitterFactory.AlreadyRegistered.selector);
        factory.register();
    }

    function test_Register_RevertsWhenPaused() public {
        factory.pause();
        vm.prank(dev1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.register();
    }

    // ---------------------------------------------------------------
    // Group 2: CREATE2 cross-component invariant via OZ Clones
    // ---------------------------------------------------------------

    function test_Register_PredictedAddressMatchesClonesPredict() public view {
        address[3] memory devs = [dev1, dev2, dev3];
        for (uint256 i = 0; i < devs.length; i++) {
            bytes32 salt = bytes32(uint256(uint160(devs[i])));
            address predicted = Clones.predictDeterministicAddress(
                factory.vaultImpl(),
                salt,
                address(factory)
            );
            address onChain = factory.computeVaultAddress(devs[i]);
            assertEq(
                predicted,
                onChain,
                "OZ Clones.predictDeterministicAddress diverges from factory.computeVaultAddress"
            );
        }
    }

    // ---------------------------------------------------------------
    // Group 4: setFeeBps()
    // ---------------------------------------------------------------

    function test_SetFeeBps_OwnerOnly() public {
        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        factory.setFeeBps(100);
    }

    function test_SetFeeBps_RevertsOnTooHigh() public {
        vm.expectRevert(PaymentSplitterFactory.InvalidFeeBps.selector);
        factory.setFeeBps(1001);

        vm.expectRevert(PaymentSplitterFactory.InvalidFeeBps.selector);
        factory.setFeeBps(type(uint16).max);
    }

    function test_SetFeeBps_AcceptsValidValues() public {
        uint16[4] memory values = [uint16(0), uint16(50), uint16(500), uint16(1000)];
        for (uint256 i = 0; i < values.length; i++) {
            factory.setFeeBps(values[i]);
            assertEq(factory.feeBps(), values[i], "feeBps not updated");
        }
    }

    function test_SetFeeBps_EmitsEvent() public {
        vm.expectEmit(false, false, false, true, address(factory));
        emit FeeBpsUpdated(50, 100);
        factory.setFeeBps(100);
    }

    // ---------------------------------------------------------------
    // Group 5: setPlatformTreasury()
    // ---------------------------------------------------------------

    function test_SetPlatformTreasury_OwnerOnly() public {
        address nonOwner = makeAddr("nonOwner");
        address newTreasury = makeAddr("newTreasury");
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        factory.setPlatformTreasury(newTreasury);
    }

    function test_SetPlatformTreasury_RevertsOnZero() public {
        vm.expectRevert(PaymentSplitterFactory.ZeroAddress.selector);
        factory.setPlatformTreasury(address(0));
    }

    function test_SetPlatformTreasury_HappyPathEmitsEvent() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(false, false, false, true, address(factory));
        emit PlatformTreasuryUpdated(treasury, newTreasury);
        factory.setPlatformTreasury(newTreasury);
        assertEq(factory.platformTreasury(), newTreasury);
    }

    // ---------------------------------------------------------------
    // Group 6: Ownable2Step
    // ---------------------------------------------------------------

    function test_Ownable2Step_TransferRequiresAccept() public {
        address newOwner = makeAddr("newOwner");
        factory.transferOwnership(newOwner);
        // Pending transfer — newOwner is NOT yet the owner.
        assertEq(factory.owner(), address(this), "owner changed before accept");
        assertEq(factory.pendingOwner(), newOwner, "pendingOwner not recorded");
        // newOwner cannot use owner-only functions until accept.
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        factory.setFeeBps(100);
    }

    function test_Ownable2Step_AcceptCompletesTransfer() public {
        address newOwner = makeAddr("newOwner");
        factory.transferOwnership(newOwner);
        vm.prank(newOwner);
        factory.acceptOwnership();
        assertEq(factory.owner(), newOwner, "owner not transferred");
        // Old owner loses owner-only powers.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setFeeBps(100);
    }

    function test_Ownable2Step_CancelByNewTransfer() public {
        address newOwner = makeAddr("newOwner");
        address other = makeAddr("other");
        factory.transferOwnership(newOwner);
        factory.transferOwnership(other);
        // pendingOwner is now `other`; newOwner can no longer accept.
        assertEq(factory.pendingOwner(), other, "pendingOwner not overwritten");
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        factory.acceptOwnership();
    }

    // ---------------------------------------------------------------
    // Group 7: pause() / unpause()
    // ---------------------------------------------------------------

    function test_Pause_OwnerOnly() public {
        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        factory.pause();
    }

    function test_Pause_BlocksRegister() public {
        factory.pause();
        assertTrue(factory.paused(), "factory not paused");
        vm.prank(dev1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.register();
    }

    function test_Unpause_RestoresRegister() public {
        factory.pause();
        factory.unpause();
        assertFalse(factory.paused(), "factory still paused");
        vm.prank(dev1);
        address vault = factory.register();
        assertTrue(vault != address(0), "register failed after unpause");
    }

    // ---------------------------------------------------------------
    // Group 8: Constructor reverts + happy path
    // ---------------------------------------------------------------

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(PaymentSplitterFactory.ZeroAddress.selector);
        new PaymentSplitterFactory(IERC20(address(0)), treasury, 50);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(PaymentSplitterFactory.ZeroAddress.selector);
        new PaymentSplitterFactory(IERC20(address(mockUsdc)), address(0), 50);
    }

    function test_Constructor_RevertsOnTooHighFee() public {
        vm.expectRevert(PaymentSplitterFactory.InvalidFeeBps.selector);
        new PaymentSplitterFactory(IERC20(address(mockUsdc)), treasury, 1001);
    }

    function test_Constructor_HappyPathReadsAllState() public view {
        assertEq(address(factory.usdc()), address(mockUsdc), "usdc mismatch");
        assertEq(factory.platformTreasury(), treasury, "treasury mismatch");
        assertEq(factory.feeBps(), 50, "feeBps mismatch");
        assertTrue(factory.vaultImpl() != address(0), "vaultImpl zero");
        assertEq(factory.owner(), address(this), "owner not deployer");
    }

    function test_Constructor_VaultImplDeployedInternally() public view {
        address impl = factory.vaultImpl();
        assertTrue(impl != address(0), "vaultImpl zero");
        assertTrue(impl.code.length > 0, "vaultImpl has no code");
    }

    // ---------------------------------------------------------------
    // Group 9: VaultDeployed event + edge cases
    // ---------------------------------------------------------------

    function test_Register_EmitsVaultDeployed() public {
        address predicted = factory.computeVaultAddress(dev1);
        vm.expectEmit(true, false, false, true, address(factory));
        emit VaultDeployed(dev1, predicted);
        vm.prank(dev1);
        factory.register();
    }

    function test_Vaults_UnregisteredReturnsZero() public {
        address unregistered = makeAddr("unregistered");
        assertEq(factory.vaults(unregistered), address(0));
    }

    function test_Register_TwoDevsProduceDistinctVaults() public {
        vm.prank(dev1);
        address v1 = factory.register();
        vm.prank(dev2);
        address v2 = factory.register();
        assertTrue(v1 != v2, "two devs returned same vault");
        assertEq(factory.vaults(dev1), v1);
        assertEq(factory.vaults(dev2), v2);
    }

    // ---------------------------------------------------------------
    // Fuzz: register idempotency
    // ---------------------------------------------------------------

    function testFuzz_RegisterIdempotent(address dev) public {
        // Skip the zero address (PaymentVaultImpl.initialize rejects it) and
        // the precompile range 1..9 where vm.prank cannot route calls through
        // the precompile. Every other address — including the [10..255] range
        // adjacent to precompiles — is a valid developer salt and must be
        // covered by the fuzzer.
        vm.assume(dev != address(0));
        vm.assume(uint160(dev) > 9);

        vm.prank(dev);
        address vault = factory.register();
        assertEq(factory.vaults(dev), vault, "vault not recorded");

        vm.prank(dev);
        vm.expectRevert(PaymentSplitterFactory.AlreadyRegistered.selector);
        factory.register();
    }
}
