// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PaymentSplitterFactory} from "../src/PaymentSplitterFactory.sol";

/**
 * @title Deploy
 * @notice Forge script that deploys `PaymentSplitterFactory` on the target chain.
 *         The factory's constructor also deploys the immutable `PaymentVaultImpl`
 *         (per iter-3 addendum §1: vaultImpl is auto-deployed inside the factory
 *         constructor — NOT passed as a constructor arg). That inner CREATE
 *         surfaces in forge's broadcast artifact at
 *         `transactions[0].additionalContracts[0].address`, which the TS
 *         post-step in `contracts/scripts/post-deploy.ts` extracts.
 * @dev Invocation (Arc Testnet):
 *        forge script script/Deploy.s.sol:Deploy \
 *          --rpc-url $ARC_RPC_URL --broadcast --verify
 *      Local smoke (anvil on chain 31337):
 *        anvil --chain-id 31337 --port 8545     # one terminal
 *        forge script script/Deploy.s.sol:Deploy \
 *          --rpc-url http://127.0.0.1:8545 --broadcast
 *      Required env: `DEPLOYER_KEY`, `PLATFORM_TREASURY_ADDRESS`.
 *      Optional env: `INITIAL_FEE_BPS` (default 50), `USDC_ADDRESS`
 *      (default: T3-verified Arc Testnet USDC at
 *      `0x3600000000000000000000000000000000000000`).
 */
contract Deploy is Script {
    /// @notice Canonical Arc Testnet USDC address, verified on-chain by T3.
    ///         See `contracts/scripts/arc-testnet-usdc-domain.json` (decisions
    ///         log Task 3) for the EIP-712 domain values and the verification
    ///         that this contract exposes `transferWithAuthorization`.
    address internal constant DEFAULT_ARC_TESTNET_USDC =
        0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address treasury = vm.envAddress("PLATFORM_TREASURY_ADDRESS");
        uint256 feeBpsRaw = vm.envOr("INITIAL_FEE_BPS", uint256(50));
        address usdc = vm.envOr("USDC_ADDRESS", DEFAULT_ARC_TESTNET_USDC);

        require(treasury != address(0), "treasury_zero");
        require(usdc != address(0), "usdc_zero");
        require(feeBpsRaw <= 1000, "feeBps_exceeds_max");

        // casting to 'uint16' is safe because feeBpsRaw <= 1000 (bounds-checked above).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 feeBps = uint16(feeBpsRaw);

        vm.startBroadcast(deployerKey);
        PaymentSplitterFactory factory =
            new PaymentSplitterFactory(IERC20(usdc), treasury, feeBps);
        vm.stopBroadcast();

        console2.log("FACTORY_ADDRESS", address(factory));
        console2.log("VAULT_IMPL_ADDRESS", factory.vaultImpl());
    }
}
