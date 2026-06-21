# Mastodon — donation-campaign provider (fediverse)

**Attach surface (verified):** `mastodon/app/controllers/api/v1/donation_campaigns_controller.rb`
fetches + caches an **external** campaign source. `mastodon/config/mastodon.yml:7`
wires it to `DONATION_CAMPAIGNS_URL` (+ `DONATION_CAMPAIGNS_ENVIRONMENT`). The
controller GETs that URL with query params `platform`, `seed`, `locale`,
`environment` and renders the returned JSON. We **fill that sanctioned slot** — no
fork change.

## Gap to close first (route not built yet)

The sidecar has no `mastodon` provider. Add a route that answers
`GET /api/v1/donation_campaigns` with the campaign JSON (draft in
`../../../../work/creator-platform-integrations/pr-drafts.md`), honoring the
`platform`/`seed`/`locale`/`environment` query params Mastodon sends. Track as
gap #2 in `deployment-plan.md`.

## Steps (after the route exists)

1. Run the provider (the sidecar in `mastodon` mode).
2. On the Mastodon instance set:
   - `DONATION_CAMPAIGNS_URL=http://up-provider:8410/api/v1/donation_campaigns`
   - `DONATION_CAMPAIGNS_ENVIRONMENT=production`
3. Mastodon fetches + caches (1h) the campaign; "donations" route through the rail
   (agent + facilitator), onchain-transparent, per-instance configurable.

## Note

Per-user creator payments (paying an author for a popular post/reshare) is a
separate **federation-peer sidecar** observing the public `attributedTo` stream — a
later vertical, also permissionless. Not in this recipe.
</content>
