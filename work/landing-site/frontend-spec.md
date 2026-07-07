---
feature: landing-site
doc: frontend-build-spec
created: 2026-07-07
audience: a frontend engineering agent (or human) building the site from scratch
---

# Universal Paywall — Website / Docs Build Spec

A build-ready specification for a **static marketing + documentation site** that
presents Universal Paywall (the rail + the "universal plugin") and gives
copy-pasteable **integration instructions per platform** — PeerTube first-class,
and the eight others alongside it.

This is a spec, not a design mockup. It defines goals, audience, information
architecture, per-page content, the data model that drives the integration pages,
tech constraints, and acceptance criteria. A frontend agent should be able to build
the whole site from this document plus the repo docs it points at.

---

## 1. Goal & positioning

One sentence: **"Get paid on the platforms you already run — without forking them.
Non-custodial, feeless, per-event settlement."**

The site must communicate, in order of priority:

1. **What it is** — an open-core, non-custodial payment rail. A viewer/agent stakes
   once and grants a bounded spending policy; a facilitator meters usage and settles
   per-event on-chain (`StakeVault`). No custody, no per-payment processor fee.
2. **The "universal" claim** — one rail, many platforms, attached **permissionlessly**
   (never editing the platform). PeerTube plugin, Owncast/Jellyfin/RSSHub sidecars,
   Mastodon donation provider, Navidrome/Subsonic music resolver, Immich reverse
   proxy, and a payer-side browser extension.
3. **How to attach it** — a per-platform integration page with concrete steps, env,
   and the exact attach surface (webhook / config redirect / plugin / provider URL /
   reverse proxy).
4. **Credibility** — it's real and tested (per-platform L1→L4 test ladder, on-chain
   settlement verified against real Docker instances). Link to the repo.

**Tone:** developer-first, honest, no hype, no token-price/ICO energy. This audience
(see §2) is allergic to marketing. Lead with mechanics and "no middleman," not with
"web3."

**Framing rule (important, from the PeerTube community research):** default the
creator-facing language to **"support / tips / get paid,"** not "paywall." Paywalling
is a *mode*, not the headline. See `work/creator-platform-integrations/` and the
`#1586` analysis for why.

---

## 2. Audiences (three, with distinct entry points)

| Audience | Wants | Primary CTA |
|---|---|---|
| **Creators** (streamers, musicians, video makers) | "How do I get paid on the platform I already use?" | Pick your platform → follow the recipe / ask your admin |
| **Instance admins / operators** | "How do I attach this to my Owncast/PeerTube/Navidrome without forking it?" | Deploy a sidecar / install the plugin |
| **Developers** | "How does the rail work, and how do I build a new integration?" | Architecture + INTEGRATION-PLAYBOOK |

The home page must fork to all three within the first screen.

---

## 3. Information architecture (sitemap)

```
/                         Home (hero, how-it-works, integration grid, credibility)
/how-it-works             The rail explained (payer → integration → facilitator → StakeVault)
/integrations             Index grid of all platforms (filter by vertical)
/integrations/peertube    Per-platform page (FIRST-CLASS — richest content)
/integrations/owncast
/integrations/navidrome
/integrations/jellyfin
/integrations/mastodon
/integrations/rsshub
/integrations/immich
/integrations/subsonic
/integrations/musicbrainz
/integrations/browser-extension
/creators                 Creator-oriented explainer + "find your platform"
/admins                   Operator-oriented (sidecar/plugin deploy overview)
/developers               Architecture deep-dive + build-a-new-integration
/docs                     Doc hub: links into the repo docs (playbook, patterns, testing)
/faq                      FAQ (custody, fees, chains, privacy, ethics)
```

Keep it flat. Every integration page is reachable in one click from `/integrations`
and from the home grid.

---

## 4. Page-by-page content

### 4.1 Home (`/`)
- **Hero:** the one-sentence positioning (§1) + two CTAs: "See how it works" and
  "Find your platform." A compact animated/annotated version of the rail diagram.
- **How it works (3 steps):** Stake & grant → Meter the event → Settle on-chain.
  Three cards, each ~2 lines. Link to `/how-it-works`.
- **Integration grid:** cards for all 9 platforms + the browser extension (§5 data
  model drives this). Each card: logo, platform name, vertical, attach-surface
  one-liner, "tested" badge, link to its page.
- **Why it's different:** four short pillars — Non-custodial · Feeless per-event ·
  Never fork the platform · Works on any instance (size-neutral).
- **Credibility strip:** "N platforms, L1→L4 tested, on-chain settlement verified,
  open source" + GitHub link.

### 4.2 How it works (`/how-it-works`)
- Full rail diagram (payer side ↔ creator side), from `README.md` / `CLAUDE.md`.
- Walk the four actors: `@universal-paywall/agent` (stake + grant policy in
  `StakeVault`), the platform event, `@universal-paywall/integrations`
  (sidecar/plugin/provider) reporting a metered charge, `@universal-paywall/facilitator`
  batching + settling. State the invariant plainly: **payee balance += rate × units.**
- Explain **permissionless attachment** — the six patterns (config-redirect,
  event-sidecar, reverse-proxy, published plugin, external provider, payer-side
  adaptor). Source: `work/creator-platform-integrations/integration-patterns.md`.
- Explain **tip-mode vs paywall-mode** as a first-class toggle in concept.

### 4.3 Integration index (`/integrations`)
- Grid + filter by vertical (Live video · VOD · Music · Feeds · Photo · Fediverse ·
  Registry · Payer-side). Cards link to per-platform pages.

### 4.4 Per-platform page (template — see §5 for the data)
Every integration page follows the SAME template so it's predictable:

1. **Header:** platform name, vertical, attach pattern, "tested" badge.
2. **What gets metered:** the event → who pays → who gets paid (one paragraph).
3. **Attach surface:** the exact hook/config/proxy/provider and that it needs **no
   fork**.
4. **Quickstart (copy-paste):** the `up-integration` env block (or plugin install)
   for this platform, from `packages/integrations/deploy/<platform>/README.md`.
5. **Verify:** the one-line on-chain check / e2e script (`npm run e2e:*`) if present.
6. **Notes/caveats:** platform-specific gotchas (e.g. PeerTube counted-view threshold;
   Mastodon SSRF allowlist; RSSHub `DISABLE_IPV6`).
7. **Links:** repo recipe README, playbook, testing-plan row.

### 4.5 PeerTube page (`/integrations/peertube`) — FIRST-CLASS, extra content
This is the flagship page (per the current focus). Beyond the template:
- Lead with **tip / support-while-you-watch**, not "paywall." Show both modes but
  default the copy to tips.
- **Operator install:** Admin → Plugins → install `universal-paywall`; then the
  settings (facilitator URL/key, price per view, viewer/channel wallet maps). Source:
  `packages/peertube-plugin/README.md`.
- **How the view is counted:** explain the `action:api.video.viewed` hook fires only
  on a *counted* view (anti-fraud watch-time threshold), and that the plugin keys the
  creator on `video.channelId ?? video.id`.
- **Revenue splits:** creator + instance host (+ PeerTube/Framasoft) — the "fund the
  whole stack" ask from issue #1586.
- **Honesty box:** settlement asset today is USDC on an L2 (not Monero/Lightning);
  it's one option beside the Support-button links; non-custodial. (Mirror the tone of
  the #1586 comment draft — this audience rewards candor.)
- Optional: a link/《discussion》 pointer to PeerTube issue #1586 as the design context.

### 4.6 Creators / Admins / Developers landing pages
- `/creators`: plain-language "get supported on the platform you use," platform
  picker, no jargon. Emphasize tips + non-custodial + you keep 100%.
- `/admins`: the sidecar/plugin deployment overview, shared prerequisites (deployed
  `StakeVaultFactory`, a running facilitator, wallet registry), link to each recipe.
  Source: `packages/integrations/deploy/README.md`.
- `/developers`: architecture, the `createReporter`/`Resolve` model, and **build a new
  integration** — embed/point to `packages/integrations/INTEGRATION-PLAYBOOK.md`
  (the instruction doc + questions script).

### 4.7 Docs hub (`/docs`) & FAQ (`/faq`)
- `/docs`: curated links into the repo docs (playbook, integration-patterns,
  testing-plan, deployment-plan, HANDOFF).
- `/faq`: custody ("non-custodial — funds stay in your `StakeVault` until a valid
  in-policy charge settles"), fees ("feeless per-event settle; no processor cut"),
  chains/assets, "do I have to fork my platform?" (no), tip vs paywall, and a candid
  privacy note (on-chain settlement is public/pseudonymous).

---

## 5. Data model that drives the integration pages

Author a single content source (JSON/YAML/`content/integrations/*.md` frontmatter)
so the grid and every page render from data, not hand-built HTML. One record per
integration:

```yaml
- slug: peertube
  name: PeerTube
  vertical: Federated VOD
  pattern: published-plugin           # config-redirect | event-sidecar | reverse-proxy | published-plugin | external-provider | payer-side
  meteredEvent: "a counted video view (action:api.video.viewed)"
  payer: "viewer (via x-payer-user header / browser extension)"
  payee: "channel wallet"
  attachSurface: "Admin → Plugins → install universal-paywall (no fork)"
  quickstart: |                        # copy-paste block
    Admin → Plugins → universal-paywall → configure:
    Facilitator URL / key, price-per-view, viewer wallet map, channel wallet map
  verifyCmd: "node packages/peertube-plugin/e2e-player-docker.mjs"
  tested: true                         # drives the badge
  recipeDoc: "packages/integrations/deploy/peertube/README.md"
  caveats: "hook fires only on a COUNTED view; creator key = video.channelId ?? video.id"
  featured: true                       # PeerTube is first-class
```

**Populate all ten records** from the repo (map below). Content is authoritative in
the repo docs — the site should paraphrase/quote them, not invent.

| slug | vertical | pattern | source recipe |
|---|---|---|---|
| peertube | Federated VOD | published-plugin | `deploy/peertube/README.md` + `packages/peertube-plugin/README.md` |
| owncast | Live video | event-sidecar | `deploy/owncast/README.md` |
| navidrome | Music | config-redirect | `deploy/navidrome/README.md` |
| subsonic | Music | config-redirect / reverse-proxy | `deploy/rsshub`… see `deploy/README.md` (PLATFORM=subsonic) |
| jellyfin | VOD | event-sidecar | `deploy/jellyfin/README.md` |
| rsshub | Feeds | event-sidecar | `deploy/rsshub/README.md` |
| immich | Photo | reverse-proxy | `deploy/immich/README.md` |
| mastodon | Fediverse | external-provider | `deploy/mastodon/README.md` |
| musicbrainz | Registry/resolver | resolver | `deploy/musicbrainz/README.md` |
| browser-extension | Payer-side | payer-side adaptor | `deploy/browser-extension/README.md` |

The `up-integration` env reference (for admin quickstarts) lives in
`packages/integrations/deploy/README.md` — reuse that env table verbatim.

---

## 6. Tech constraints

- **Static site.** Recommend **Astro** (content-collections fit the §5 data model
  perfectly) or Next.js in static-export mode. No server required; deployable to any
  static host / IPFS (a nice fit for this audience).
- **Self-contained, privacy-respecting.** No third-party analytics, no external
  trackers, no CDN font calls that phone home — this audience will check. If analytics
  are needed, self-host a privacy-preserving option and disclose it. (This mirrors the
  #1586 community's stated values.)
- **Content-driven:** integration pages generated from §5 data; adding a platform =
  adding one record + one recipe link, no bespoke page.
- **Code blocks:** copy-to-clipboard on every quickstart/env block.
- **Responsive + light/dark**, accessible (WCAG AA contrast), keyboard-navigable.
- **Diagrams:** the rail diagram as inline SVG (theme-aware), not a raster.
- **Assets:** platform logos must respect each project's trademark/branding usage;
  if unsure, use a neutral monochrome icon + name rather than an official logo.
- **No secrets** in any example (use `0x…`, `FACILITATOR_API_KEY=…` placeholders).

---

## 7. Design direction (light-touch)

- Clean, technical, generous whitespace; monospace for commands/keys.
- A single accent color; avoid "crypto neon." Think developer-docs (Stripe-docs
  clarity) minus the corporate gloss.
- The rail diagram is the signature visual — invest there.
- Badges: "tested" (green), "payer-side" (distinct), pattern chips.

---

## 8. Deliverables

1. Running static site implementing the sitemap (§3) and all page content (§4).
2. `content/integrations/*` with **all ten** records populated from the repo (§5).
3. Reusable components: `IntegrationCard`, `IntegrationPage` template, `RailDiagram`
   (SVG), `CodeBlock` (copy button), `Callout` (honesty/caveat boxes), audience CTAs.
4. A short `README.md` in the site dir: how to run, build, add an integration, and
   where content comes from.
5. All external links resolve to the repo docs listed in §5 and `/docs`.

## 9. Acceptance criteria

- [ ] Home forks to Creators / Admins / Developers above the fold.
- [ ] `/integrations` lists all 10; each card links to a working page.
- [ ] Every integration page renders the §4.4 template from data (no hardcoded HTML).
- [ ] **PeerTube page** is the richest, leads with **tips not paywall**, includes the
      revenue-split and honesty (USDC vs Monero/Lightning) boxes.
- [ ] Every command/env block has copy-to-clipboard and uses placeholder secrets only.
- [ ] Rail diagram is inline theme-aware SVG.
- [ ] No third-party trackers; light/dark; AA contrast; keyboard-navigable.
- [ ] Builds to static output with zero server dependency.
- [ ] Adding one YAML record + recipe link produces a full new integration page with
      no other code changes.

## 10. Content sources (authoritative — quote/paraphrase, don't invent)

- `README.md`, `CLAUDE.md` — positioning, rail diagram, package layout, commands.
- `packages/integrations/INTEGRATION-PLAYBOOK.md` — build-a-new-integration.
- `work/creator-platform-integrations/integration-patterns.md` — the six patterns.
- `work/creator-platform-integrations/testing-plan.md` — the L1→L4 ladder + matrix
  (drives the "tested" badges and Verify sections).
- `work/creator-platform-integrations/deployment-plan.md` + `STATUS.md` — status.
- `packages/integrations/deploy/README.md` + `deploy/<platform>/README.md` — the
  per-platform recipes and the `up-integration` env table.
- `packages/peertube-plugin/README.md` — the PeerTube plugin specifics.
- `work/HANDOFF.md` — doc index.

## 11. Out of scope (call out, don't build)

- Live payment widget / actual wallet connect (this is a docs+marketing site, not the
  app). Link to the packages instead.
- Publishing the plugin/extension to stores (that's a separate deploy task).
- Any claim that isn't backed by a repo doc or a passing test.
