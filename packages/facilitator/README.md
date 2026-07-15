# Universal Paywall Facilitator

`@universal-paywall/facilitator` exposes two rails:

- `up-facilitator`: legacy metered batching against `StakeVault`.
- `up-session-facilitator`: V1 synchronous paid sessions plus optional exact x402.

The session API is intended for services such as Mnemonic that must receive an
idempotent payment before incurring delivery costs. It fixes one payee per
wallet-approved policy and settles each operation independently.

## Session API

```text
POST /v1/quotes
POST /v1/sessions
GET  /v1/sessions/{session_id}
POST /v1/payments/settle
GET  /v1/payments/{operation_id}
GET  /.well-known/payment-receipt-key
```

Service routes require `X-API-Key`. Health and receipt-key discovery are
public. See `openapi.yaml`, `schemas/`, and `fixtures/` for the stable wire
contract and shared digest vectors.

Session authorization uses EIP-712 domain `Universal Paywall Session`, version
`1`, chain ID from deployment configuration, and the payer's
`SessionStakeVault` as `verifyingContract`. The same signature can be relayed
through `grantPolicyBySig`; later session creation therefore needs no payer gas
transaction. `scopeHash` commits to service, session, subject, network,
workspace, visibility, and allowed checkpoint actions.

Operation binding digests use `UP-OPBIND-1`: compact UTF-8 JSON with fields in
the spec-defined order and a lowercase hex BLAKE3 hash. `operation_id` is a
stable correlation ID, `nonce` is a UUID, and `scope.workspace_hash` is a 64
character hex string with an optional `0x` prefix. Receipts sign their
`UP-JCS-1` canonical payload (recursively sorted JSON keys) with Ed25519 and
include a rotating `key_id`.

## Run locally

Build and deploy `SessionStakeVaultFactory`, then configure:

```bash
SERVICE_ID=mnemonic NETWORK=eip155:5042002 CHAIN_ID=5042002 \
ARC_RPC_URL=http://127.0.0.1:8545 USDC_ADDRESS=0x... \
SESSION_STAKE_VAULT_FACTORY=0x... FACILITATOR_KEY=0x... SERVICE_PAY_TO=0x... \
SERVICE_API_KEYS=staging-key PAYMENT_STORE_PATH=./data/payments.json \
RECEIPT_PRIVATE_KEY_FILE=./receipt-ed25519.pem RECEIPT_KEY_ID=staging-1 \
npx up-session-facilitator
```

The configured factory is a security boundary. Session registration and every
settlement verify that `factory.vaults(payer)` matches the submitted vault and
that the vault reports the expected payer, factory, and USDC asset. Set
`MAX_SESSION_SECONDS` to the operator-approved upper bound (default: seven
days).

Set `EXACT_PAYMENTS_ENABLED=1`, `USDC_EIP712_NAME`, and
`USDC_EIP712_VERSION` to enable the optional EIP-3009 path.

The built-in file store fsyncs atomic snapshots and survives restart. It is a
single-writer deployment store. Horizontal deployments must provide a
transactional shared-store implementation with unique service/operation keys.
Never log API credentials, wallet proofs, or receipt private keys.

## Security considerations

- `RECEIPT_PRIVATE_KEY_FILE` must be readable only by the facilitator process
  (permissions are enforced at startup).
- `QUOTE_TTL_SECONDS` and `MAX_SESSION_SECONDS` are capped to sensible maximums
  at startup; configure the smallest values your clients can tolerate.
- Quote creation and session registration are serialized per
  `operation_id`/`session_id` to prevent races on the in-memory store.
- On-chain reconciliation scans the most recent `100_000` blocks plus the
  configured `SESSION_RAIL_FROM_BLOCK`, avoiding unbounded RPC queries.
- RPC failures during vault trust checks are propagated instead of silently
  returning `false`.
- Session authorization failures return a generic `invalid_session_authorization`
  response while the specific reason is logged server-side.
