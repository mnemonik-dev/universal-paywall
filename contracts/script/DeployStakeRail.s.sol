// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {StakeVaultFactory} from "../src/rail/StakeVaultFactory.sol";

/**
 * @title DeployStakeRail
 * @notice Forge script that deploys the feeless, ownerless `StakeVaultFactory`.
 *         The factory's constructor also deploys the immutable `StakeVault`
 *         implementation (auto-deployed inside the constructor — not a
 *         constructor arg); that inner CREATE surfaces in forge's broadcast
 *         artifact at `transactions[0].additionalContracts[0].address`.
 * @dev Unlike the legacy `Deploy.s.sol`, there is NO treasury and NO fee — the
 *      rail is a neutral public good. The only constructor arg is USDC.
 *
 *      Invocation (Arc Testnet):
 *        forge script script/DeployStakeRail.s.sol:DeployStakeRail \
 *          --rpc-url $ARC_RPC_URL --broadcast --verify
 *      Local smoke (anvil on chain 31337):
 *        anvil --chain-id 31337 --port 8545
 *        forge script script/DeployStakeRail.s.sol:DeployStakeRail \
 *          --rpc-url http://127.0.0.1:8545 --broadcast
 *      Required env: `DEPLOYER_KEY`.
 *      Optional env: `USDC_ADDRESS` (default: Arc Testnet USDC).
 */
contract DeployStakeRail is Script {
    address internal constant DEFAULT_ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address usdc = vm.envOr("USDC_ADDRESS", DEFAULT_ARC_TESTNET_USDC);

        require(usdc != address(0), "usdc_zero");

        vm.startBroadcast(deployerKey);
        StakeVaultFactory factory = new StakeVaultFactory(usdc);
        vm.stopBroadcast();

        console2.log("STAKE_VAULT_FACTORY", address(factory));
        console2.log("STAKE_VAULT_IMPL", factory.vaultImpl());
        console2.log("USDC", usdc);
    }
}
