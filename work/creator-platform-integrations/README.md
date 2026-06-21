---
feature: creator-platform-integrations
status: sidecars-implemented
created: 2026-06-17
branch: feat/creator-platform-integrations
base: feat/facilitator-rail
source: "Canteen — The Distribution Bootstrap for Payments Founders (2026-05-28)"
source_url: https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html
---

# Creator-Platform Integrations

Implements the per-vertical **sidecar integrations** the Canteen essay calls for,
attaching the Universal Paywall facilitator rail (`feat/facilitator-rail`) to the
open-source creator stack.

> Source note: the article host is blocked by this environment's egress policy,
> so this work uses the previously-ingested article snapshot (analyzed in
> `work/x402-agent-payment/external-analysis.md`). Content is unchanged.

## Does our solution align with the article? — Yes, precisely

The essay's thesis: distribution comes from **permissionlessly attaching** to the
OSS creator stack (sidecar / plugin / wrapper / federation-peer / client-fork) and
settling **per-event** over an **onchain rail with batched settlement** that
dissolves the fiat fee floor — **non-custodial, no protocol rent**, with the
**payee registry as the moat**. Its #8 is a portable, chain-agnostic **Settlement
Core** under all the verticals.

Our `feat/facilitator-rail` is exactly that core:

| Article requirement | Our rail |
|---|---|
| Non-custodial, no protocol rent | `StakeVault` + factory: feeless, ownerless, pauseless |
| Rail-level **batched** settlement (dissolves fee floor) | facilitator aggregates charges → one `settle(creators[],amounts[])` |
| Per-event settlement | `StakeVault.settle` per batch; SDK `charge()` per event |
| Permissionless integration | external swappable facilitator; sidecars call the SDK |
| Sidecar "reads a settlement-grade event stream" | this package: scrobble / webhook / feed adapters |
| Payee registry = moat | injectable `resolvePayer` / `resolveCreator` resolvers |
| Chain-agnostic Settlement Core (#8) | `NETWORKS`-style config; EIP-3009 on any USDC chain |

**Conclusion:** the rail is the article's Settlement Core (#8); this batch builds
the attachment sidecars (#1–7). A consumer pre-stakes + grants via
`@universal-paywall/agent`; a platform sidecar reports each consumption event via
`@universal-paywall/sdk`; the facilitator batches and settles.

## The integration model is sidecars, NOT upstream PRs

The article is explicit: integration shapes are **permissionless**
(sidecar/plugin/wrapper) — and empirically, upstreams **merge server-admin
donation pointers but reject per-user payment plumbing**. So for the cleanest
verticals the "way to integrate" is **a sidecar you ship yourself**, not a PR into
the upstream repo.

Therefore:
- **Sidecar verticals (music, live, VOD, feeds, photo):** implemented here as
  runnable adapters that attach via each platform's *existing public API*. No
  upstream PR is needed or appropriate.
- **Plugin / provider verticals (PeerTube plugin loader, Mastodon
  donation-campaigns API):** the integration is a **plugin/provider you publish**,
  not a core PR. Drafts + the exact upstream path are documented in
  `platforms.md`.
- **Actual submission to external repos is out of scope here**: this environment's
  GitHub access is restricted to `mnemonik-dev/universal-paywall`, and pushing
  unsolicited payment code into other communities' repos needs explicit
  maintainer + user sign-off. Everything is left PR-ready with instructions.

## What's in this batch

- `platforms.md` — the platform list, per-platform integration pattern, event
  surface, and PR-vs-sidecar verdict.
- `packages/integrations/` — runnable reference sidecars for the four cleanest
  verticals (Subsonic/Navidrome, Owncast, Jellyfin, RSSHub), each translating a
  platform event stream into `@universal-paywall/sdk` charges, with tests.
- PR-draft notes for the plugin/provider verticals (PeerTube, Mastodon).
