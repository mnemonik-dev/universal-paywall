# Mastodon — donation-campaign provider (fediverse)

**Attach surface (verified):** `mastodon/app/controllers/api/v1/donation_campaigns_controller.rb`
fetches + caches an **external** campaign source. `mastodon/config/mastodon.yml:7`
wires it to `DONATION_CAMPAIGNS_URL` (+ `DONATION_CAMPAIGNS_ENVIRONMENT`). The
controller GETs that URL with query params `platform`, `seed`, `locale`,
`environment` and renders the returned JSON. We **fill that sanctioned slot** — no
fork change.

## Route status: BUILT (gap #2 closed)

The sidecar now serves the provider at `GET /api/v1/donation_campaigns`
(`src/mastodon.ts` + `mastodonCampaignRoute`, `PLATFORM=mastodon`), verified
against `mastodon/.../donation_campaigns_controller.rb` and its request spec:

- Responds **200** with the campaign JSON, echoing the requested `locale` (so
  Mastodon's `id:locale` cache key is stable), or **204** when no campaign is set.
- Emits the current schema (`amounts` is a nested `{one_time,monthly}` object — the
  old `pr-drafts.md` array shape was stale and is corrected here).

## Configure the campaign

Either a full `CAMPAIGN_JSON` (the template minus `locale`), or discrete vars:

| Env | Default |
|---|---|
| `CAMPAIGN_DONATION_URL` | **required** — donor stake/checkout URL (settles via the rail) |
| `CAMPAIGN_ID` | `universal-paywall` |
| `CAMPAIGN_BANNER_MESSAGE` | "Support this instance — settles onchain…" |
| `CAMPAIGN_BANNER_BUTTON_TEXT` | `Donate` |
| `CAMPAIGN_DONATION_MESSAGE` / `_BUTTON_TEXT` / `_SUCCESS_POST` | sensible defaults |
| `CAMPAIGN_AMOUNTS` | `{"one_time":{"USD":[5,10,25]},"monthly":{"USD":[5]}}` |
| `CAMPAIGN_DEFAULT_CURRENCY` | `USD` |

No `FACILITATOR_URL` needed — the provider only serves config; donations settle
later at `donation_url` via `@universal-paywall/agent` + the facilitator.

## Steps

1. Run the provider (`docker-compose.yml`, `PLATFORM=mastodon`).
2. On the Mastodon instance set:
   - `DONATION_CAMPAIGNS_URL=http://up-provider:8410/api/v1/donation_campaigns`
   - `DONATION_CAMPAIGNS_ENVIRONMENT=production`
3. Mastodon fetches + caches (1h) the campaign and renders the banner; the
   `donation_url` flow routes "donations" through the rail, onchain-transparent.

## Verify

`curl 'http://localhost:8410/api/v1/donation_campaigns?platform=web&seed=1&locale=en'`
returns the campaign JSON with `"locale":"en"`; unset the campaign → `204`.

## Note

Per-user creator payments (paying an author for a popular post/reshare) is a
separate **federation-peer sidecar** observing the public `attributedTo` stream — a
later vertical, also permissionless. Not in this recipe.
</content>
