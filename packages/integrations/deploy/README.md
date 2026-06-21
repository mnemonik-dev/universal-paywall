# Deployment Recipes

Per-platform recipes that attach the Universal Paywall rail to a creator platform
using **only that platform's existing configuration surface** — the platform forks
are never modified. Each recipe wires three processes:

```
platform instance  ──event──▶  up-integration sidecar  ──charge──▶  facilitator  ──settle──▶  StakeVault
   (this folder)                (@universal-paywall/integrations)    (@universal-paywall/facilitator)   (contracts/src/rail)
```

> Status: **scaffold**. Attach points and env are grounded against the actual
> forks (see `work/creator-platform-integrations/deployment-plan.md`), but
> per-instance wallet maps and a few sidecar routes are marked `TODO` and built
> per-platform in the recommended order.

## Shared prerequisites (every recipe)

1. A deployed `StakeVaultFactory` (`contracts/script/DeployStakeRail.s.sol`) on the
   target chain (anvil for local; Arc Testnet for staging).
2. A running facilitator (`up-facilitator`) with its API key.
3. At least one **consumer** that has staked + granted a policy via
   `@universal-paywall/agent` (the payer side).
4. A wallet registry for the platform's identities — supplied to the sidecar as
   `PAYER_WALLETS` / `CREATOR_WALLETS` JSON maps (the "moat"; static maps for now).

## The sidecar (`up-integration`)

| Env | Meaning |
|---|---|
| `PLATFORM` | `subsonic` \| `navidrome` \| `owncast` \| `jellyfin` \| `rsshub` \| `mastodon` |
| `FACILITATOR_URL` / `FACILITATOR_API_KEY` | where to report charges |
| `PAYER_WALLETS` / `CREATOR_WALLETS` | JSON maps: platform id → `0x` wallet |
| `RATE` | unit price (per play / per second / per minute / per citation), micro-USDC |
| `STREAMER_KEY` | Owncast only: the creator key for the stream |
| `PORT` | sidecar port (default `8410`) |
| `SIDECAR_API_KEY` | optional `x-api-key` gate on the sidecar |

## Recipes

| Folder | Platform | Attach surface | Build status |
|---|---|---|---|
| `owncast/` | Owncast (live) | admin webhook → `/owncast` | route exists; e2e-proven |
| `navidrome/` | Navidrome (music) | `ND_LISTENBRAINZ_BASEURL` → sidecar | route built (`PLATFORM=navidrome`) |
| `jellyfin/` | Jellyfin (VOD) | official webhook plugin → `/jellyfin` | route exists |
| `rsshub/` | RSSHub (feeds) | crawler boundary → `/citation` | route exists |
| `mastodon/` | Mastodon (fediverse) | `DONATION_CAMPAIGNS_URL` → provider | route built (`PLATFORM=mastodon`) |
| `peertube/` | PeerTube (fed. VOD) | published plugin → sidecar | **needs published plugin** |
| `musicbrainz/` | MusicBrainz (registry) | WS/2 MBID lookups → resolver | **needs registry resolver** |
</content>
