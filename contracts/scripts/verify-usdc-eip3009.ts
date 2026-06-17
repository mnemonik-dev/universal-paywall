/**
 * Wave 2 spike: probe live Arc Testnet USDC for EIP-3009 surface + gas economics.
 *
 * Source RPC:       process.env.ARC_RPC_URL ?? https://rpc.testnet.arc.network
 * Target USDC:      0x3600000000000000000000000000000000000000 (canonical Arc Testnet USDC)
 * Chain ID:         5042002 (arc-testnet)
 * Toolchain:        viem only (per iter-4 §4 — T3 stays TS via viem, independent of Foundry).
 *                   Invoked with `tsx`, NOT through Hardhat. No `hre`, no ethers.
 *
 * Output:
 *   - Single-line JSON to stdout (smoke-check expectation):
 *       {name, version, decimals, supportsEip3009, sampleGasCost, gasCostExceedsThreshold, notes?}
 *   - Pretty-printed JSON written to ./arc-testnet-usdc-domain.json (sole handoff to Task 6).
 *
 * Consumer contract (iter-4 §5 T3):
 *   Task 6 (`packages/middleware/src/networks.ts`) reads the artifact and
 *   populates NETWORKS['arc-testnet'].usdcEip712Name / .usdcEip712Version.
 *   Task 6 also reads `notes[]` at module load and surfaces every entry via
 *   warn-level log — INFORMATIONAL ONLY, NEVER blocking module init.
 *   Therefore every observation worth surfacing at runtime MUST land in `notes[]`.
 *
 * Exit codes:
 *   - 0  → success (gasCostExceedsThreshold may be true; warning printed but not blocking)
 *   - 1  → hard blocker: supportsEip3009 === false, decimals !== 6, RPC unreachable,
 *          name()/version() revert, or selector self-check fails.
 *
 * See: work/x402-agent-payment/tasks/3.md
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

const USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000';
const ARC_CHAIN_ID = 5042002;
const DEFAULT_RPC_URL = 'https://rpc.testnet.arc.network';

// Threshold from tech-spec Risks row "Per-payment settlement creates per-event gas overhead":
// 5% of a 0.01 USDC payment = 0.0005 USDC = 500 micro-USDC.
const GAS_COST_THRESHOLD_MICRO_USDC = 500n;

// Expected selector for transferWithAuthorization per EIP-3009 (NOT 0xef55bec6, which
// is receiveWithAuthorization). Verified by selector self-check below.
const EXPECTED_TWA_SELECTOR: Hex = '0xe3ee160e';

const TWA_SIGNATURE =
  'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)';

// Used only when the live node refuses to estimate gas. The lower bound is documented
// in `notes[]` so T6 surfaces it at module load.
const GAS_ESTIMATE_FALLBACK = 60_000n;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

const USDC_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  `function ${TWA_SIGNATURE}`,
]);

interface UsdcEip3009Probe {
  name: string;
  version: string;
  decimals: number;
  supportsEip3009: boolean;
  sampleGasCost: string;
  gasCostExceedsThreshold: boolean;
  notes?: string[];
}

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'arc-testnet',
  rpcUrls: {
    default: { http: [process.env.ARC_RPC_URL ?? DEFAULT_RPC_URL] },
  },
  // Empirical: the live contract's name() returns 'USDC' (not the marketing
  // form 'USD Coin'). viem uses this field for display only — kept aligned
  // with the on-chain value so downstream consumers see a consistent name.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
});

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Retry only transport-level failures; surface logic errors immediately.
      const isTransport =
        err instanceof HttpRequestError ||
        err instanceof TimeoutError ||
        (err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError) !== null);
      if (!isTransport || attempt === retries) throw err;
      const backoffMs = 250 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  // Unreachable: the loop either returns or rethrows.
  throw lastErr;
}

async function readUsdcDomain(client: PublicClient): Promise<{
  name: string;
  version: string;
  decimals: number;
}> {
  const [name, version, decimals] = await Promise.all([
    withRetry('name', () =>
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'name' }),
    ),
    withRetry('version', () =>
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'version' }),
    ),
    withRetry('decimals', () =>
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' }),
    ),
  ]);
  return { name, version, decimals };
}

/**
 * Method-existence detection strategy:
 *
 * authorizationState(address,bytes32):
 *   View call with zero arguments. A USDC-compliant contract returns `false`
 *   (no authorization recorded). If the selector is missing entirely the call
 *   either reverts at the dispatcher or returns 0 bytes — viem surfaces this
 *   as ContractFunctionZeroDataError. Treat that as "method absent".
 *
 * transferWithAuthorization(...):
 *   Non-view. We cannot actually execute it without a valid signature, so we
 *   ask the node to estimate gas for a dummy call. A revert from the function
 *   body (invalid signature → EIP-3009 nonce / sig check fails) proves the
 *   dispatcher routed the call — i.e., the selector exists. A
 *   ContractFunctionZeroDataError (returndata=0x at the dispatcher fallback)
 *   means the selector is absent.
 *
 *   Ambiguous outcomes (e.g., a node-level error that is not a clean revert
 *   AND not zero-data) are reported via `notes[]` and DO NOT flip
 *   supportsEip3009 to true.
 */
async function probeAuthorizationState(
  client: PublicClient,
  notes: string[],
): Promise<{ exists: boolean }> {
  try {
    await withRetry('authorizationState', () =>
      client.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: 'authorizationState',
        args: [ZERO_ADDRESS, ZERO_BYTES32],
      }),
    );
    return { exists: true };
  } catch (err) {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError)) {
      return { exists: false };
    }
    if (err instanceof ContractFunctionExecutionError) {
      // A revert from the function body means the dispatcher hit it.
      notes.push(
        `authorizationState: existence inferred from revert (${err.shortMessage ?? 'no message'})`,
      );
      return { exists: true };
    }
    notes.push(
      `authorizationState: ambiguous probe outcome — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exists: false };
  }
}

async function probeTransferWithAuthorization(
  client: PublicClient,
  notes: string[],
): Promise<{ exists: boolean; gasEstimate: bigint | null }> {
  // Dummy args. Signature components are zero; the call must revert at signature
  // verification — that revert is exactly the proof the selector exists.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const dummyArgs = [
    ZERO_ADDRESS, // from
    ZERO_ADDRESS, // to
    10_000n, // value = 0.01 USDC in micro-USDC
    nowSec - 60n, // validAfter
    nowSec + 3600n, // validBefore
    ZERO_BYTES32, // nonce
    27, // v
    ZERO_BYTES32, // r
    ZERO_BYTES32, // s
  ] as const;

  try {
    const gasEstimate = await withRetry('estimateContractGas', () =>
      client.estimateContractGas({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: 'transferWithAuthorization',
        args: dummyArgs,
        account: ZERO_ADDRESS,
      }),
    );
    return { exists: true, gasEstimate };
  } catch (err) {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError)) {
      return { exists: false, gasEstimate: null };
    }
    if (err instanceof ContractFunctionExecutionError) {
      // Revert from inside the function = selector exists; we just couldn't get a
      // gas number because the call reverted before the body completed.
      return { exists: true, gasEstimate: null };
    }
    notes.push(
      `transferWithAuthorization: gas estimation unavailable — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exists: false, gasEstimate: null };
  }
}

async function readGasPriceWei(client: PublicClient, notes: string[]): Promise<bigint | null> {
  // Any throw here — transport error, unsupported method, post-retry transport
  // failure, or `0n` result — is treated identically: this pricing path is
  // unusable, fall through to the EIP-1559 path. Discriminating further would
  // change nothing downstream; both branches end at the same notes[] entry.
  try {
    const price = await withRetry('getGasPrice', () => client.getGasPrice());
    if (price > 0n) return price;
  } catch {
    // Intentional: any error here means "legacy gasPrice unavailable"; the
    // EIP-1559 branch below is the next thing to try.
  }
  try {
    const fees = await withRetry('estimateFeesPerGas', () => client.estimateFeesPerGas());
    const candidate = fees.maxFeePerGas ?? fees.gasPrice;
    if (candidate !== undefined && candidate > 0n) return candidate;
  } catch {
    // Intentional: any error here means "1559 fee estimate unavailable too";
    // we record the unavailability via `notes` and let the caller skip the
    // threshold check rather than crash the spike.
  }
  notes.push('gas pricing unavailable, threshold check skipped');
  return null;
}

function microUsdcFromGasCostWei(gasCostWei: bigint): bigint {
  // Arc treats USDC as native gas: gas is denominated in 18-decimal wei-scale
  // (per the chain's nativeCurrency.decimals = 18), but the ERC-20 view exposes
  // decimals() = 6. Converting native-wei → micro-USDC therefore drops 12 decimals.
  // Round-up so we don't under-report cost on small fractional values.
  const scale = 10n ** 12n;
  return (gasCostWei + scale - 1n) / scale;
}

async function main(): Promise<void> {
  const notes: string[] = [];

  // 1. Selector self-check — guards against an ABI-string typo in this file.
  const computedSelector = toFunctionSelector(TWA_SIGNATURE);
  if (computedSelector !== EXPECTED_TWA_SELECTOR) {
    console.error(
      `[verify-usdc-eip3009] FATAL: selector mismatch. Expected ${EXPECTED_TWA_SELECTOR}, computed ${computedSelector}. ` +
        `ABI signature string in this script is wrong; fix before re-running.`,
    );
    process.exit(1);
  }

  const client = createPublicClient({ chain: arcTestnet, transport: http() });

  let domain: { name: string; version: string; decimals: number };
  try {
    domain = await readUsdcDomain(client);
  } catch (err) {
    const message =
      err instanceof BaseError
        ? err.shortMessage
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[verify-usdc-eip3009] RPC unavailable or USDC reverted view call: ${message}`);
    process.exit(1);
  }

  const authStateProbe = await probeAuthorizationState(client, notes);
  const twaProbe = await probeTransferWithAuthorization(client, notes);
  const supportsEip3009 = authStateProbe.exists && twaProbe.exists;

  let sampleGasCostMicroUsdc: bigint;
  let gasCostExceedsThreshold = false;

  if (!supportsEip3009) {
    // Hard blocker — economics are moot.
    sampleGasCostMicroUsdc = 0n;
  } else {
    let gasEstimate = twaProbe.gasEstimate;
    if (gasEstimate === null) {
      gasEstimate = GAS_ESTIMATE_FALLBACK;
      notes.push(
        `gas estimation fallback applied: assumed ${GAS_ESTIMATE_FALLBACK.toString()} gas (node refused estimate for reverting call)`,
      );
    }

    const gasPriceWei = await readGasPriceWei(client, notes);
    if (gasPriceWei === null) {
      sampleGasCostMicroUsdc = 0n;
    } else {
      // gasPriceWei: 18-decimal native wei per unit gas.
      // gasEstimate: dimensionless gas units.
      // gasCostWei: 18-decimal native wei (total).
      // microUsdc:  6-decimal ERC-20 view of the same cost.
      const gasCostWei = gasEstimate * gasPriceWei;
      sampleGasCostMicroUsdc = microUsdcFromGasCostWei(gasCostWei);

      // Sanity check: a 60k-gas tx at any plausible mainnet-like gasPrice should
      // land between 1 and 1e9 micro-USDC. If we drift far outside that band,
      // the dual-decimal conversion is almost certainly wrong — bail rather than
      // publish a misleading number.
      const wildlyLow = sampleGasCostMicroUsdc === 0n && gasCostWei > 0n;
      const wildlyHigh = sampleGasCostMicroUsdc > 10n ** 12n;
      if (wildlyLow || wildlyHigh) {
        console.error(
          `[verify-usdc-eip3009] FATAL: gas cost conversion produced an implausible value (${sampleGasCostMicroUsdc} micro-USDC ` +
            `from ${gasCostWei} wei). Refusing to publish a wrong number — inspect dual-decimal handling.`,
        );
        process.exit(1);
      }

      notes.push('arc-dual-decimal: native gas is 18-decimal but ERC-20 view is 6');
      gasCostExceedsThreshold = sampleGasCostMicroUsdc > GAS_COST_THRESHOLD_MICRO_USDC;
    }
  }

  const probe: UsdcEip3009Probe = {
    name: domain.name,
    version: domain.version,
    decimals: domain.decimals,
    supportsEip3009,
    sampleGasCost: `${sampleGasCostMicroUsdc.toString()} micro-USDC`,
    gasCostExceedsThreshold,
  };
  const out: UsdcEip3009Probe = notes.length > 0 ? { ...probe, notes: [...notes] } : probe;

  // Stdout: single-line JSON for the smoke check.
  console.log(JSON.stringify(out));

  // Artifact: pretty-printed copy beside this script for T6 to consume.
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactPath = resolve(here, 'arc-testnet-usdc-domain.json');
  writeFileSync(artifactPath, `${JSON.stringify(out, null, 2)}\n`);

  // Hard blockers — exit non-zero so the wave halts and we pivot per Risks fallback.
  if (!supportsEip3009) {
    console.error(
      '[verify-usdc-eip3009] HARD BLOCKER: supportsEip3009 === false. ' +
        'Evaluate Base Sepolia fallback per tech-spec Risks row "Arc Testnet USDC doesn\'t expose transferWithAuthorization".',
    );
    process.exit(1);
  }
  if (domain.decimals !== 6) {
    console.error(
      `[verify-usdc-eip3009] HARD BLOCKER: decimals === ${domain.decimals} (expected 6). ` +
        'Dual-decimal foot-gun confirmed; D4 fee math invalid for this chain.',
    );
    process.exit(1);
  }

  if (gasCostExceedsThreshold) {
    console.warn(
      `[verify-usdc-eip3009] WARNING: sampleGasCost ${probe.sampleGasCost} exceeds ` +
        `${GAS_COST_THRESHOLD_MICRO_USDC.toString()} micro-USDC threshold (5% of a 0.01 USDC payment). ` +
        'Per-payment economics need a post-MVP batched-settlement follow-up; not blocking.',
    );
  }
}

main().catch((err) => {
  // Last-resort guard — keep the message operator-friendly, no stack dump.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[verify-usdc-eip3009] unexpected failure: ${message}`);
  process.exit(1);
});
