# PeerTube — per-view (federated VOD)

**Attach surface (verified):** PeerTube exposes the server hook
`action:api.video.viewed` (`PeerTube/packages/models/src/plugins/server/server-hook.model.ts:186`).
There is **no native view webhook** — confirmed by inspecting the fork — so a
sidecar cannot observe views without a plugin.

## Why this one needs a published plugin (still not a fork edit)

Under the sidecars-only decision we do not modify the PeerTube fork. Instead the
operator installs a **separately published** `peertube-plugin-universal-paywall`
(draft `main.js` in
`../../../../work/creator-platform-integrations/pr-drafts.md`) that registers the
`action:api.video.viewed` hook and calls the sidecar/facilitator on each view. The
enabling upstream change already landed (`req.rawBody`, PeerTube PR #6300).

## Steps

1. Build + publish `peertube-plugin-universal-paywall` (separate package; gap #3 in
   `deployment-plan.md`). Not built this session.
2. Operator installs the plugin and configures: facilitator URL + API key, viewer
   wallet map, channel wallet map, price per view.
3. View a video → plugin → facilitator charge → settle.

## Verify

`docker run peertube`, install the local plugin build, view a video, confirm settle.

> No `docker-compose.yml` here yet: the recipe is gated on the plugin existing.
</content>
