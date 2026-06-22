# Universal Paywall

Open-core, non-custodial payment rail for HTTP services and creator platforms.
Consumers (AI agents or human-driven clients) stake USDC once and grant a bounded
spending policy; a facilitator batches metered usage and settles it **per event,
feelessly and non-custodially, on-chain** (`StakeVault`). Service owners and
creators get paid from both audiences — and **without modifying the platforms they
run**. Attachment is always permissionless (config-redirect, event-sidecar,
reverse-proxy, published plugin, external provider, or payer-side adaptor); the
platform forks under `mnemonik-dev/*` are never edited.

## Architecture (the rail)

```
payer: @universal-paywall/agent  ──stake + grant policy──▶  StakeVault
platform event ──▶ @universal-paywall/integrations (sidecar/plugin/provider)
                                  ──metered charge──▶ @universal-paywall/facilitator
                                  ──batched settle──▶ StakeVault  (creator paid: rate × units)
```

The payer side also has `@universal-paywall/extension` (MV3 browser extension) that
auto-pays the paywalls the creator-side integrations meter.

## Project Structure

```
packages/agent/            # @universal-paywall/agent — payer: stake, grant, fetchWithPaywall
packages/facilitator/      # @universal-paywall/facilitator — batch + on-chain settle (up-facilitator)
packages/integrations/     # @universal-paywall/integrations — creator-side adapters (up-integration)
packages/extension/        # @universal-paywall/extension — payer-side MV3 adaptor
packages/peertube-plugin/  # peertube-plugin-universal-paywall — published view-hook plugin
packages/sdk/              # @universal-paywall/sdk — shared client/types
packages/resource-adapter/ # @universal-paywall/resource-adapter — x402 resource helper
packages/middleware/       # @universal-paywall/middleware — legacy per-payment x402 (see README History)
contracts/                 # Foundry: src/rail/ (StakeVault, StakeVaultFactory) + legacy PaymentVault/Factory
```

## Key Commands

```bash
# Install all dependencies
npm install

# Unit tests (vitest per package) + contract tests
npm test --workspaces --if-present
cd contracts && forge test

# Build a rail package
npm run build -w @universal-paywall/integrations

# Run a creator-side sidecar (env-driven; PLATFORM = owncast|navidrome|subsonic|jellyfin|rsshub|mastodon|immich-proxy)
PLATFORM=owncast FACILITATOR_URL=... FACILITATOR_API_KEY=... \
PAYER_WALLETS='{...}' CREATOR_WALLETS='{...}' RATE=1000 npx up-integration

# Run the facilitator
npx up-facilitator

# On-chain money loops (anvil :8545 + built contracts)
npm run e2e:anvil    -w @universal-paywall/integrations
npm run e2e:owncast  -w @universal-paywall/integrations
npm run e2e:mastodon -w @universal-paywall/integrations
npm run e2e:anvil    -w @universal-paywall/extension

# Deploy the rail (Foundry)
cd contracts && forge script script/DeployStakeRail.s.sol --rpc-url $ARC_RPC_URL --broadcast
```

## Project Knowledge & integration docs

- `packages/integrations/INTEGRATION-PLAYBOOK.md` — how to build a new integration
  (instruction doc + questions script).
- `work/creator-platform-integrations/integration-patterns.md` — the six
  permissionless attachment patterns.
- `work/creator-platform-integrations/testing-plan.md` — four-layer test ladder
  (L1 unit → L2 HTTP contract → L3 real Docker → L4 anvil on-chain) + matrix.
- `work/creator-platform-integrations/{deployment-plan,STATUS}.md` and
  `packages/integrations/deploy/<platform>/` — fork-free attach recipes + status.
- `work/HANDOFF.md` — doc index + environment gotchas (Docker/anvil/gitleaks).
- `.claude/skills/project-knowledge/references/` — architecture, deployment, UX.

## Conventions

- **Never modify the platform forks** — integrate only through their existing
  config/plugin/proxy/provider surfaces.
- Public anvil dev keys in e2e harnesses are annotated `// gitleaks:allow`.
- A gitleaks pre-commit hook gates commits (installed at `~/.local/bin`).

## Default Branch

`main` — production. Feature branches off `dev`. PRs go to `dev` first.
