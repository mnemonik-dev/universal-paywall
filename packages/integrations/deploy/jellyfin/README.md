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

`docker compose up`, install the webhook plugin, play+stop, confirm minutes settle.
</content>
