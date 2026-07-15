// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SessionStakeVaultFactory} from "../src/rail/SessionStakeVaultFactory.sol";

/**
 *  Deploys the fixed-payee, operation-idempotent session rail.
 */
contract DeploySessionRail is Script {
    function run() external returns (SessionStakeVaultFactory factory) {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        vm.startBroadcast(deployerKey);
        factory = new SessionStakeVaultFactory(usdc);
        vm.stopBroadcast();
        console2.log("SESSION_STAKE_VAULT_FACTORY", address(factory));
        console2.log("SESSION_STAKE_VAULT_IMPL", factory.vaultImpl());
    }
}
