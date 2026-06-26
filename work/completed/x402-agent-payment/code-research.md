---
feature: x402-agent-payment
created: 2026-06-16
updated: 2026-06-16
status: draft
---

# Code Research: x402-agent-payment

## Repo state (current)

```
universal-paywall/
  .claude/                 # global skills/methodology setup
  .gitignore
  CLAUDE.md                # top-level project instructions (updated for Arc Network)
  work/x402-agent-payment/ # this feature
```

No `packages/`, `apps/`, `contracts/` directories exist yet. **All implementation is greenfield.**

## External references (verified 2026-06-16)

### x402 protocol — official sources

- Spec: `https://github.com/coinbase/x402` (`specs/schemes/exact/scheme_exact_evm.md`, `specs/x402-specification.md`)
- Network support (CDP facilitator): `https://docs.cdp.coinbase.com/x402/network-support`
- Verified wire format:
  - 402 body (content-type `application/json`): `{ x402Version: 1, accepts: [PaymentRequirements], error?: string }`
  - `PaymentRequirements`: `{ scheme: "exact", network, maxAmountRequired, resource, description, mimeType, payTo, maxTimeoutSeconds, asset, outputSchema?, extra }`
  - For EIP-3009 exact: `extra: { assetTransferMethod: "eip3009", name, version }`
  - `X-PAYMENT` header (canonical case): `base64(JSON({ x402Version: 1, scheme, network, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } }))` — `payload` is strictly `{signature, authorization}`, no extra fields (off-the-shelf clients won't add them).
  - `X-PAYMENT-RESPONSE` header: `base64(JSON({ success, transaction, network, payer }))`
  - Network ID: canonical **CAIP-2** strings — `eip155:8453` (Base), `eip155:84532` (Base Sepolia), `eip155:5042002` (Arc Testnet). x402 community also accepts named aliases (`base`, `base-sepolia`); for Arc we publish both `eip155:5042002` and `arc-testnet` for client convenience.
- Settlement model: **facilitator pattern**. Client signs EIP-3009 authorization off-chain (no gas). Server (facilitator) calls `USDC.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` directly on the USDC token contract and pays gas. CDP facilitator does NOT support Arc — we self-host.

### Arc Network (Circle Arc) — verified

- Sources: `developers.circle.com/stablecoins/usdc-contract-addresses`, `thirdweb.com/arc-testnet`, `faucet.circle.com`
- **Arc Mainnet — not launched** as of 2026-06. MVP targets Testnet only.
- Arc Testnet:
  - Chain ID: `5042002` (CAIP-2: `eip155:5042002`)
  - RPC: `https://rpc.testnet.arc.network` (official). Fallback mirror: `https://5042002.rpc.thirdweb.com`.
  - USDC: `0x3600000000000000000000000000000000000000` — **system contract**, native gas token. Decimals: 6 (ERC-20 interface). **Foot-gun:** Arc USDC exposes a dual interface — 18-decimal native (for gas accounting) and 6-decimal ERC-20 (for transfers). All facilitator math uses the 6-decimal ERC-20 view.
  - Block explorer: `https://testnet.arcscan.app`
  - Faucet: `https://faucet.circle.com` (select Arc Testnet, 1 USDC/day)
  - **EIP-712 domain** for USDC must be read from chain at deploy time (Wave 1 spike). Likely values: `name = "USD Coin"` (Circle FiatTokenV2 standard returns `"USD Coin"`, not `"USDC"`), `version = "2"`, `chainId = 5042002`, `verifyingContract = 0x3600...`.
  - EIP-3009 support: assumed (Circle-native USDC implements it universally). **Wave 1 Task 3 verifies on chain.**

### EIP-3009

- Spec: `https://eips.ethereum.org/EIPS/eip-3009`
- Function: `transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` — `from` is an explicit argument; USDC does NOT ecrecover `from` from the signature but uses it as the verification target.
- EIP-712 message type:
  ```
  TransferWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce
  )
  ```
- `nonce` is 32-byte client-generated random. Token contract maintains `authorizationState[from][nonce]` mapping. Replay-protected at token layer.
- Signature recovers to `from`. Anyone can submit (`msg.sender` unconstrained).

## Architecture implications — Path 2 (per-developer vault factory)

### Why the contract changed (security-driven)

Earlier draft proposed a shared `PaymentSplitter.payWithAuthorization(developerId, …)`. Multiple validators independently flagged that this design has a cross-developer payment-attribution attack: when a single shared splitter is the `payTo` address, an adversary intercepting a signed X-PAYMENT can race-submit it to a different developer's middleware (with a different `developerId` argument) and credit the wrong developer.

**Fix:** per-developer vault model. Each developer's `payTo` is a unique address (deterministic clone), so the EIP-3009 `to` field cryptographically binds the payment to the correct recipient. No `developerId` argument is needed anywhere because the address itself encodes it. As a side benefit:
- Open-registration griefing dissolved — vaults are deployed with `msg.sender` as the immutable developer; an attacker pre-registering someone else's address yields a vault they cannot withdraw from.
- The `usedTxSigs` / `payWithAuthorization` wrapper contract calls go away — middleware calls `USDC.transferWithAuthorization` directly.

### Contracts

```
PaymentSplitterFactory.sol  (Ownable2Step, Pausable)
  + immutable usdc
  + platformTreasury  (settable by owner)
  + feeBps  (uint16, 0..1000, settable by owner)
  + vaultImpl  (PaymentVaultImpl deployed in constructor)
  + vaults: mapping(address => address)
  + register() returns (address vault):
      require !vaults[msg.sender], require !paused
      vault = Clones.cloneDeterministic(vaultImpl, bytes32(uint256(uint160(msg.sender))))
      IPaymentVault(vault).initialize(msg.sender)
      vaults[msg.sender] = vault
      emit VaultDeployed(msg.sender, vault)
  + computeVaultAddress(address developer) view returns (address):
      return Clones.predictDeterministicAddress(vaultImpl, …, address(this))
  + setFeeBps(uint16): owner-only, require bps <= 1000, emit FeeBpsUpdated
  + setPlatformTreasury(address): owner-only, require addr != 0, emit PlatformTreasuryUpdated
  + pause() / unpause(): owner-only

PaymentVaultImpl.sol  (Initializable, ReentrancyGuard)
  + developer: address  (set on initialize, no setter)
  + factory: address    (back-pointer: read usdc, feeBps, platformTreasury)
  + initialize(address _developer):
      initializer modifier; require _developer != 0;
      developer = _developer; factory = msg.sender
  + withdraw() nonReentrant:
      require msg.sender == developer
      IFactory f = IFactory(factory)
      IERC20 usdc = IERC20(f.usdc())
      uint256 gross = usdc.balanceOf(address(this))
      require gross > 0, "no_balance"
      uint16 feeBps = f.feeBps()
      uint256 fee = gross * feeBps / 10000
      uint256 net = gross - fee
      SafeERC20.safeTransfer(usdc, developer, net)
      if (fee > 0) SafeERC20.safeTransfer(usdc, f.platformTreasury(), fee)
      emit Withdrawal(developer, gross, fee)
```

`paused` is observed off-chain by the middleware (`factory.paused()` read), not enforced at vault level — vaults remain usable for `withdraw` even when paused (developers never locked out of accumulated USDC).

### Middleware (self-hosted facilitator)

1. **402 build**: `payTo = factory.computeVaultAddress(developerEOA)` (pure function, off-chain, no RPC); `asset = usdcAddress`; `network` as both CAIP-2 (`eip155:5042002`) and alias (`arc-testnet`). Verify on startup that `factory.vaults[developerEOA] != 0` — if vault not deployed yet, the 402 includes `error: "vault_not_deployed"` plus instructions.
2. **Verify (off-chain)**: viem `recoverTypedDataAddress` with domain `{ name: USDC.name(), version: USDC.version(), chainId: NETWORKS[id].chainId, verifyingContract: usdcAddress }`. Reject if recovered ≠ `authorization.from`. Check `to == expectedVaultAddress`, `value >= maxAmountRequired`, `validBefore > now + 5s`, `validAfter <= now`, payload.network matches config.network, and `(from, nonce)` not in NonceStore (synchronous has + insert).
3. **Settle (on-chain)**: WalletClient with relayer key calls `USDC.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` directly on USDC contract. `waitForTransactionReceipt({hash, timeout: 30s})`.
4. **Settlement failure taxonomy**: distinct error reasons surfaced to the agent — `rpc_timeout`, `rpc_5xx`, `gas_estimate_revert`, `mine_timeout`, `receipt_reverted`, `relayer_no_balance`.
5. **Response**: 200 + `X-PAYMENT-RESPONSE: base64({success: true, transaction, network, payer: from})`.

### NonceStore (in-memory, single-process)

- `Map<from, Set<nonce>>` with parallel `Map<from-nonce-key, validBeforeMs>` for eviction. On every `has` call, lazily evict expired entries (`validBefore < now`).
- **TOCTOU**: `has` + `insert` are a single synchronous block in `verify.ts` — no `await` between them.
- **Size cap**: 100 000 entries max per process to bound memory. If exceeded, evict oldest by `validBefore` (FIFO).
- Multi-instance scope: post-MVP (Redis-backed). Documented limitation.

### Network ID convention

All public artifacts (402 body `network`, X-PAYMENT `network`) accept BOTH CAIP-2 (`eip155:5042002`) and the alias (`arc-testnet`). Middleware normalizes on read to the canonical CAIP-2 form for chainId lookup. Spec compliance: x402 v1 requires CAIP-2; alias is a convenience.

### Open verification items (for implementation, Wave 1 Task 3 spike)

- USDC at `0x3600000000000000000000000000000000000000` exposes `transferWithAuthorization` (4-byte selector `0xef55bec6`) and `authorizationState(address,bytes32)`.
- EIP-712 domain values: read `name()`, `version()`, expected `chainId = 5042002`, `verifyingContract = 0x3600…`.
- `decimals()` returns `6` on the ERC-20 interface.
- Live read of `factory.vaults[developer]` works through standard RPC.

### Known unknowns (deferred or accepted)

- Arc Mainnet chainId, USDC address, RPC — not actionable in MVP (chain not launched).
- Reorg depth on Arc Testnet — assume 1 block finality; document.
- Relayer wallet gas in USDC (Arc gas is USDC). Out of scope: auto-refill. Monitoring documented in README.
- Multi-instance NonceStore (Redis) — post-MVP.
- Wallet rotation — post-MVP.
