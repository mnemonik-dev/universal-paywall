# Project Handoff — Universal Paywall (facilitator rail + creator integrations)

A single entry point to the current state of this work, what's done, what's left,
and everything needed to continue in a fresh session — including one with the
external **platform repos** available.

_Last updated: 2026-06-17._

## TL;DR

The project pivoted from the original **per-payment, fee-in-contract,
self-hosted-facilitator** design (`packages/middleware`, on `dev`) to a
**feeless, non-custodial, batched-settlement facilitator rail** with permissionless
creator-platform sidecars. The new design is implemented, unit-tested, and proven
end-to-end on a local chain across every actor. External-repo PRs are **not** done
(out of scope + permissionless-by-design) but are drafted and documented.

## Branch map

| Branch | Contents | Base |
|---|---|---|
| `main` | production (mostly empty scaffold) | — |
| `dev` | **old paradigm** impl (`packages/middleware`, `PaymentSplitterFactory`) + all review docs in `work/x402-agent-payment/` | main |
| `feat/facilitator-rail` | **new rail**: contracts + facilitator + sdk + resource-adapter + agent; `work/facilitator-rail/` | dev |
| `feat/creator-platform-integrations` | **sidecars**: `packages/integrations` + `work/creator-platform-integrations/`; this is the most advanced branch (inherits the rail) | feat/facilitator-rail |

> Work continues on `feat/creator-platform-integrations` (it contains everything).
> Neither feature branch is merged to `dev` yet — open PRs when ready (the original
> repo flow is `feat/* → dev → main`).

## Why the pivot (read these first)

The original `x402-agent-payment` design was reviewed and found to have real
gaps. The new rail resolves them. Evidence trail in `work/x402-agent-payment/`:
- `review.md` — spec logic/relevance findings (replay flaw, x402 model contradiction, Base→Arc inconsistencies).
- `economics-review.md` — **the decisive one**: per-payment gas ≈ 12.6% of a $0.01 payment vs a 0.5% fee; relayer fragility; mandatory fee; no min-withdraw.
- `external-analysis.md` + `external-analysis-response.md` — the Canteen "Distribution Bootstrap" thesis and how it maps (full thesis map with links).
- `work/facilitator-rail/facilitator-rail-design.md` — the new paradigm (the design doc that drove the implementation).

**Carried-forward decision:** the old-paradigm docs (`tech-spec.md`, `decisions.md`,
diagrams, `.claude/skills/project-knowledge/references/*`, `CLAUDE.md`, `README.md`)
still describe the OLD model and contradict the new one. They need reconciliation or
supersession (see "What's left").

## Package inventory (on `feat/creator-platform-integrations`)

| Package | Role | Tests |
|---|---|---|
| `contracts/src/rail/` (`StakeVault`, `StakeVaultFactory`) | feeless, non-custodial, ownerless settlement rail | 39 (Foundry) |
| `@universal-paywall/facilitator` | external batching facilitator: ledger, batcher, viem settler, x402 `402` edge + grant gate, HTTP API, CLI | 20 |
| `@universal-paywall/sdk` | zero-dep creator→facilitator charge client | 4 |
| `@universal-paywall/resource-adapter` | resource-server gate: `withStakePaywall` (node) + `fastifyStakePaywall`; proof verify + grant gate + 402 + usage report | 10 |
| `@universal-paywall/agent` | payer auto-pay: `createPayerAgent().fetchWithPaywall` (create-vault/deposit/grant/sign/retry) | 7 |
| `@universal-paywall/integrations` | creator-platform sidecars (Subsonic/Owncast/Jellyfin/RSSHub/Immich) + serve layer + `up-integration` CLI | 17 |
| `packages/middleware` | **OLD paradigm** (per-payment, fee-in-vault). Deprecated; kept for reference | 202 (on dev) |

**New-rail unit tests: 97.** Plus 4 anvil e2es (settle / adapter / agent /
integration) — all PASS.

## Architecture in one diagram

```
PAYER (agent)            RESOURCE SERVER             FACILITATOR (external)        RAIL (contracts)
@up/agent                @up/resource-adapter        @up/facilitator               contracts/src/rail
  fetchWithPaywall  ──>  withStakePaywall  ──402──>  (build402/checkGrant)
  create-vault/deposit/grant ───────────────────────────────────────────────────> StakeVaultFactory/StakeVault
  signed proof      ──>  verify + grant gate ─200─>  serve
                         report usage ─charge──────> ledger → batch → settle ─────> StakeVault.settle (batched)
CREATOR PLATFORM (sidecar) @up/integrations: scrobble/webhook/citation/resolve → @up/sdk.charge → facilitator
```

Money: payer stakes USDC in their own `StakeVault`, grants a bounded policy to the
facilitator; the facilitator batches metered charges and settles direct to creators;
**no fee in the rail, no custody, no pause.** Fee (if any) lives at the facilitator.

## Environment bootstrap (IMPORTANT for a fresh container)

This container started with **no Foundry, no solc, no gitleaks, no node_modules**.
All were fetched from allowlisted hosts (GitHub/npm). A new session must repeat:

```bash
# JS deps (npm registry allowlisted)
npm install

# Foundry binaries (GitHub releases allowlisted)
curl -fL -o /tmp/foundry.tgz https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz
mkdir -p /tmp/foundry && tar -xzf /tmp/foundry.tgz -C /tmp/foundry      # forge, cast, anvil, chisel
export PATH="/tmp/foundry:$PATH"

# Contract submodules (OZ v5.0.2 + forge-std) — needed for forge build
git submodule update --init --recursive

# solc 0.8.20 (svm path; GitHub allowlisted) — forge can't fetch it (egress)
mkdir -p ~/.svm/0.8.20
curl -fL -o ~/.svm/0.8.20/solc-0.8.20 https://github.com/ethereum/solidity/releases/download/v0.8.20/solc-static-linux
chmod +x ~/.svm/0.8.20/solc-0.8.20
# then build/test OFFLINE so forge uses the local solc:
( cd contracts && FOUNDRY_OFFLINE=true forge test --match-path 'test/rail/*' )

# gitleaks 8.18.4 (pre-commit hook requires it; GitHub allowlisted)
curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz | tar -xz -C /tmp gitleaks
install -m0755 /tmp/gitleaks ~/.local/bin/gitleaks
```

> **TODO (high value):** add a `SessionStart` hook (the `session-start-hook` skill)
> that runs the above so web sessions are ready without manual bootstrapping.

### Running tests / e2es
```bash
# unit
npm test --workspace=@universal-paywall/<facilitator|sdk|resource-adapter|agent|integrations>
( cd contracts && FOUNDRY_OFFLINE=true forge test --match-path 'test/rail/*' )

# anvil e2es — start anvil first, run, then `pkill -x anvil` (NOT `pkill -f anvil`:
# it matches the *-anvil.ts script filenames and kills the test)
export PATH="/tmp/foundry:$PATH"
nohup anvil --chain-id 31337 --port 8545 --silent >/tmp/anvil.log 2>&1 & disown; sleep 3
npm run e2e:anvil -w @universal-paywall/facilitator        # settle path
npm run e2e:anvil -w @universal-paywall/resource-adapter   # 402 → grant → serve → settle
npm run e2e:anvil -w @universal-paywall/agent              # agent auto-pay loop
npm run e2e:anvil -w @universal-paywall/integrations       # Owncast → sidecar → settle
pkill -x anvil
```

### Gotchas learned
- **Docker works** in this environment — the daemon just isn't auto-started. As root:
  `nohup dockerd >/tmp/dockerd.log 2>&1 &` then `docker pull` (Docker Hub reachable).
  Enables real L3 platform runs (proven: live Owncast → real webhook → on-chain settle).
- `pkill -f anvil` kills the e2e scripts (filenames contain "anvil") — use `pkill -x anvil`.
- Egress allowlist blocks many hosts (`x402.org`, `thecanteenapp.com`); GitHub/npm/code.claude.com are allowed. Article content lives in `work/x402-agent-payment/external-analysis.md`.
- Public anvil dev keys in e2e scripts are annotated `// gitleaks:allow` (not secrets).
- viem `policy()` read on an undeployed counterfactual vault throws → `createPolicyReader` catches and returns a zero policy (so the gate cleanly 402s).

## What's done

- ✅ New rail contracts (feeless/non-custodial/ownerless) + full Foundry suite.
- ✅ Facilitator service (batched settlement) + x402 `402` edge + grant gate + CLI.
- ✅ Creator SDK + payer agent (auto-pay) + resource adapter (node + fastify).
- ✅ Creator-platform sidecars for 5 verticals + runnable servers + CLI.
- ✅ 4 anvil e2es covering every layer.
- ✅ Deploy script for the rail factory.
- ✅ Platform list, integration patterns, PR/plugin drafts, alignment analysis.

## What's left (roadmap)

**Hardening / rail**
- [ ] Payee-allowlist + signed-receipt dual-auth on `StakeVault.settle` (beyond cap-bounding).
- [ ] Min-withdrawal guard on `StakeVault` (dust withdrawals are gas-negative — see economics-review).
- [ ] Gasless EIP-3009 `receiveWithAuthorization` funding; durable (non-in-memory) facilitator ledger.
- [ ] Extract `@universal-paywall/rail-core` for shared read-only primitives (adapter/agent currently borrow/duplicate ABI + gate helpers).

**Deployment / proof**
- [ ] Arc Testnet e2e against live USDC + a deployed factory (need RPC + funds).
- [ ] Per-sidecar Docker/compose + webhook-registration recipes.
- [ ] Real MusicBrainz/EXIF/author→wallet **registry** (the "moat") beyond `mapResolver`.

**Upstream platform integration** (needs platform repos in scope — see the dedicated guide)
- [ ] Publish PeerTube plugin; run Mastodon campaign provider; Immich reverse-proxy variant.
- [ ] Verify each sidecar against a real platform instance.

**Docs**
- [ ] Reconcile or supersede the old-paradigm docs (`tech-spec`, `decisions`, diagrams, project-knowledge, `CLAUDE.md`, `README.md`).
- [ ] Add the SessionStart bootstrap hook.

## Doc index

- `work/HANDOFF.md` — this file.
- `work/facilitator-rail/` — `facilitator-rail-design.md` (the design), `implementation-plan.md`, `STATUS.md`.
- `work/creator-platform-integrations/` — `README.md` (alignment), `platforms.md` (the list), `pr-drafts.md`, `STATUS.md`, **`upstream-integration-guide.md`** (next-session guide), **`deployment-plan.md`** (grounded per-platform recipes + gap status, forks in scope), **`testing-plan.md`** (L1–L4 verification per platform).
- `packages/integrations/deploy/<platform>/` — runnable sidecar-attach recipes (Owncast/Navidrome/Jellyfin/RSSHub/Mastodon) + design docs for PeerTube plugin, MusicBrainz resolver, and the payer-side browser-extension adaptor.
- `work/x402-agent-payment/` — original spec + the review docs that justified the pivot.
