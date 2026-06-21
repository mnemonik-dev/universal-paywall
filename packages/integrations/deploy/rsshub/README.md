# RSSHub — per-citation toll (feeds)

**Attach surface (verified):** `RSSHub/lib/types.ts:37,88` exposes `DataItem.link`
and `DataItem.author`; `RSSHub/lib/middleware/` is the middleware layer. The
sidecar's `citationRoute` already accepts `{ crawlerId, link, author }` and charges
a per-citation toll.

## Preferred shape: crawler boundary (no fork change)

The cleanest attach is **crawler-side**: when an LLM agent grounds an answer in a
source URL served via RSSHub, it POSTs the citation to the sidecar
(`http://up-sidecar:8410/citation`). This keeps RSSHub untouched and bills the
party that actually monetizes the content (the crawler) per grounded citation.

## Alternative: RSSHub middleware (operator-run, still no fork edit)

Run a thin middleware in front of RSSHub that stamps an `x-payment` attribution
token per `DataItem` and reports a citation when a crawler fetches it. Document as
an operator add-on, not an upstream change.

## Config

- `PLATFORM=rsshub`, `RATE=<micro-USDC per citation>`
- `PAYER_WALLETS={"<crawlerId>":"0x..."}`, `CREATOR_WALLETS={"<author-url>":"0x..."}`

## Verify

Run RSSHub, fetch a feed, POST a citation event for one item, confirm it settles.
</content>
