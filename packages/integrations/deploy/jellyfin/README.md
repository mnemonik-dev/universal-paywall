# Jellyfin — per-minute VOD

**Attach surface (verified):** playback state lives in
`jellyfin/Jellyfin.Api/Controllers/PlaystateController.cs`. The integration uses
the **official** `jellyfin-plugin-webhook` (a separate, first-party plugin — not a
fork edit) to POST playback notifications to the sidecar. The sidecar's
`jellyfinRoute` already bills whole minutes on `PlaybackStop`.

## Steps

1. Start rail + facilitator + sidecar + Jellyfin (`docker-compose.yml`).
2. In Jellyfin: Dashboard → Plugins → Catalog → install **Webhook**.
3. Add a webhook destination `http://up-sidecar:8410/jellyfin`, subscribed to
   `PlaybackStop` (and optionally `PlaybackProgress`), with a template that emits:
   `NotificationType`, `UserId`, `ItemId`, `PlaybackPositionTicks`.
4. Play + stop a video → sidecar bills `floor(position_minutes) * RATE` to the
   resolved creator → facilitator settles.

## Config

- `PLATFORM=jellyfin`, `RATE=<micro-USDC per minute>`
- `PAYER_WALLETS={"<UserId>":"0x..."}`, `CREATOR_WALLETS={"<ItemId>":"0x..."}`

## Verify

**Real L3+L4 (PROVEN 2026-06-21):** `scripts/e2e-jellyfin-live-docker.mjs` runs the
full loop against a live `ghcr.io/jellyfin/jellyfin` (10.11.11) + the official
Webhook plugin (21.0.0.0): wizard, Movie library, plugin config (`PlaybackStop`,
`SendAllProperties` -> our `/jellyfin`), a reported playback start/stop, settle on
anvil. The plugin's real payload matched the route exactly (`NotificationType`,
`UserId`, `ItemId`, `PlaybackPositionTicks`); 2 min -> 2000 micro-USDC. The script
header has the complete container/wizard/plugin bring-up. On a fresh server the
plugin catalog can be empty — drop the release zip into `/config/plugins/Webhook`
and restart.

Quick check: `docker compose up`, install the webhook plugin, play+stop, confirm
minutes settle.
</content>
