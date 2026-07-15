# Session API Deployment Status

The synchronous session rail is not deployed to production. Clients must keep
the paid-session feature flag disabled until a staging deployment passes the
Mnemonic end-to-end compatibility and failure audit.

## Intended staging network

- Network: Arc Testnet (`eip155:5042002`)
- USDC: `0x3600000000000000000000000000000000000000`
- Settlement: one confirmed `settleOperation` transaction per checkpoint
- Gas: paid by the Universal Paywall facilitator; no on-chain protocol fee
- Session factory, facilitator, Mnemonic payee, API URL, and receipt key: to be
  recorded here after deployment and verification

Deploy with `contracts/script/DeploySessionRail.s.sol`, publish verified source,
and set `SESSION_RAIL_FROM_BLOCK` to its deployment block. Back up the payment
store and Ed25519 receipt key independently. Test restore and on-chain
reconciliation before enabling traffic.

Pin `SESSION_STAKE_VAULT_FACTORY`; never accept a payer-supplied factory. Record
the receipt endpoint's `public_key_base64url` in Mnemonic configuration rather
than trusting a key fetched dynamically from the same payment connection.

Set the payment-store directory to mode `0700` and the receipt private-key file
to `0600`. Review startup validation errors before exposing the API: invalid
`CHAIN_ID`, missing `SERVICE_API_KEYS`, oversized TTLs, or an insecure key file
all abort launch.

Required readiness checks include funded facilitator gas, RPC chain-ID pinning,
receipt-key discovery, writable durable storage, session-vault reads, and a
successful no-value reconciliation probe. Never reuse staging API credentials
or receipt keys in production.
