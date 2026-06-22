# Universal Paywall

Open-core, non-custodial payment rail for HTTP services and creator platforms.
Consumers (AI agents or human-driven clients) stake USDC once and grant a bounded
spending policy; a facilitator batches metered usage and settles it **per event,
feelessly and non-custodially, on-chain**. Service owners and creators get paid
without writing any settlement code — and **without modifying the platforms they
run** (Owncast, Navidrome, Jellyfin, PeerTube, Mastodon, RSSHub, Immich, …).

## How it works (the rail)

```
        PAYER SIDE                          CREATOR / PAYEE SIDE
  ┌───────────────────┐               ┌──────────────────────────────┐
  │ @universal-paywall │   x402 /     │  platform instance (unforked) │
  │      /agent        │  stamped     │            │ event            │
  │  stake + grant ───▶│  request     │            ▼                  │
  │  policy in         │              │  @universal-paywall/integrations │
  │  StakeVault        │              │   sidecar / plugin / provider │
  └─────────┬─────────┘               └──────────────┬───────────────┘
            │                                         │ metered charge
            │                                         ▼
            │                          @universal-paywall/facilitator
            │                            (batches charges)
            │                                         │ settle (batched)
            └────────────────────────────────────────▼
                              StakeVault  (feeless, non-custodial, on-chain)
                              creator paid:  rate × units
```

- **Payer** stakes USDC in a `StakeVault` and grants the facilitator a bounded,
  revocable policy (cap + expiry). Nothing is custodied — funds stay in the vault
  until a valid, in-policy charge settles them.
- **Creator-side integration** observes a platform event (a play, a counted view, a
  scrobble, a citation, a shared-link resolve) and reports a metered charge to the
  facilitator. The platform itself is never forked — attachment is always through
  the platform's existing config/plugin/proxy surface.
- **Facilitator** batches charges and calls `StakeVault.settle` on-chain. The
  universal invariant every test asserts: **payee balance += rate × units**.

## Project Structure

```
packages/agent/            # @universal-paywall/agent — payer: stake, grant policy, fetchWithPaywall
packages/facilitator/      # @universal-paywall/facilitator — batches metered charges, settles on-chain (up-facilitator CLI)
packages/integrations/     # @universal-paywall/integrations — creator-side sidecars/plugins/providers (up-integration CLI)
packages/extension/        # @universal-paywall/extension — payer-side MV3 browser-extension adaptor
packages/peertube-plugin/  # peertube-plugin-universal-paywall — published PeerTube view-hook plugin
packages/sdk/              # @universal-paywall/sdk — shared client/types
packages/resource-adapter/ # @universal-paywall/resource-adapter — x402 resource helper
packages/middleware/       # @universal-paywall/middleware — legacy per-payment x402 middleware (see History)
contracts/                 # Foundry: rail/ (StakeVault, StakeVaultFactory) + legacy PaymentVault/Factory
```

## Key Commands

```bash
# Install all dependencies
npm install

# Run all unit tests (vitest across packages) + contract tests
npm test --workspaces --if-present
cd contracts && forge test

# Build the rail packages
npm run build -w @universal-paywall/agent
npm run build -w @universal-paywall/facilitator
npm run build -w @universal-paywall/integrations

# Run a creator-side sidecar for any supported platform (env-driven)
PLATFORM=owncast \
FACILITATOR_URL=http://localhost:8402 FACILITATOR_API_KEY=k \
PAYER_WALLETS='{"viewer-1":"0x..."}' CREATOR_WALLETS='{"stream":"0x..."}' \
RATE=1000 npx up-integration

# Run the facilitator
FACILITATOR_KEY=0x... STAKE_VAULT_FACTORY=0x... npx up-facilitator

# End-to-end on-chain money loops (need anvil :8545 + built contracts)
npm run e2e:anvil    -w @universal-paywall/integrations   # full vertical: stake → event → settle
npm run e2e:owncast  -w @universal-paywall/integrations   # Owncast L4 over real HTTP
npm run e2e:mastodon -w @universal-paywall/integrations   # Mastodon donation L4
npm run e2e:anvil    -w @universal-paywall/extension      # payer-side auto-pay loop
```

## Supported platform integrations

Every integration attaches **without modifying the platform** — it uses one of six
permissionless patterns (config-redirect, event-sidecar, reverse-proxy, published
plugin, external provider, payer-side adaptor).

| Platform | Vertical | Attach surface | Pattern |
|---|---|---|---|
| Owncast | Live video | admin webhook → sidecar | event-sidecar |
| Navidrome | Music | `ND_LISTENBRAINZ_BASEURL` → ListenBrainz-shaped sidecar | config-redirect |
| Subsonic (gonic, …) | Music | scrobble endpoint → sidecar | config-redirect |
| Jellyfin | VOD | official Webhook plugin → sidecar | event-sidecar |
| RSSHub | Feeds | crawler/citation boundary → sidecar | event-sidecar |
| Immich | Photo | reverse proxy meters shared-link resolves | reverse-proxy |
| Mastodon | Fediverse | `DONATION_CAMPAIGNS_URL` → campaign provider | external provider |
| PeerTube | Federated VOD | published `action:api.video.viewed` plugin | published plugin |
| MusicBrainz | Registry/resolver | WS/2 `recording_mbid → artist_mbid → wallet` | resolver (the moat) |
| Any browser extension | Payer side | `agent.fetchWithPaywall` + MV3 messaging bridge | payer-side adaptor |

All ten are verified against **real Docker'd instances** with on-chain settlement;
see the documentation below.

## Documentation

- **`packages/integrations/INTEGRATION-PLAYBOOK.md`** — the instruction doc +
  "questions script" for building a new integration from scratch.
- **`work/creator-platform-integrations/integration-patterns.md`** — the six
  permissionless attachment patterns and when to use each.
- **`work/creator-platform-integrations/testing-plan.md`** — the four-layer test
  ladder (L1 unit → L2 sidecar HTTP contract → L3 real Docker instance → L4 anvil
  on-chain money loop) and the per-platform matrix.
- **`work/creator-platform-integrations/deployment-plan.md`** + the per-platform
  recipes in **`packages/integrations/deploy/<platform>/`** — grounded, fork-free
  attach recipes.
- **`work/creator-platform-integrations/STATUS.md`** — current build/test status.
- **`work/HANDOFF.md`** — doc index and environment gotchas (Docker, anvil, gitleaks).
- `.claude/skills/project-knowledge/references/` — architecture, deployment, and UX
  references.

## History / legacy

`packages/middleware` and the `contracts/src/PaymentSplitterFactory` +
`PaymentVaultImpl` contracts are the **original per-payment x402 design**: an HTTP
service returns `402 Payment Required`, an x402-aware agent pays inline per request,
and funds route to a per-developer vault. That path still builds and tests, but the
current architecture is the **stake-once / meter-and-batch StakeVault rail** above,
which is what the platform integrations settle against. New work should target the
rail; the middleware remains for x402-native, per-request endpoints.

## Default Branch

`main` — production. Feature branches off `dev`. PRs go to `dev` first. Integration
work for this effort lives on `claude/universal-paywall-integrations-2xsjwu`.
