# Universal Paywall — UX Guidelines

## Surfaces

Two distinct UI surfaces:

1. **Hosted checkout page** (`pay.universalpaywall.com/checkout`) — shown to human users hitting a paywalled resource
2. **Developer dashboard** (`app.universalpaywall.com`) — shown to developers managing their account

## Hosted Checkout Page

### Goal
Human user lands here after being redirected from a paywalled service. They should understand what they're paying for, trust the payment, and complete it in under 30 seconds.

### Principles
- **Minimal friction.** One screen, one action: pay. No account creation required.
- **Trust signals.** Show merchant name, resource description, price. Stripe badge visible.
- **Transparent pricing.** Show exact amount. No hidden fees shown to the user (our 0.5% is invisible — taken from merchant side).
- **Fast redirect.** On success, redirect back immediately. No "thank you" page unless merchant configures one.

### Elements
- Merchant name + resource description (passed as URL params)
- Price in USD (or local currency via Stripe)
- "Pay with card" button → Stripe Checkout (hosted by Stripe, full redirect)
- Small "Secured by Universal Paywall" footer

## Developer Dashboard

### Goal
Developers should quickly understand their revenue, see who is paying (agent vs human), and manage their integration in minutes.

### Principles
- **Data first.** Numbers on the landing page, not marketing.
- **Agent vs Human split** is the key insight — always visible.
- **Minimal settings.** Onboarding is linear: connect Stripe → add wallet → copy API key. Three steps, done.

### Key Screens

**Dashboard home:**
- Total revenue (period selector: 7d / 30d / all time)
- Transactions count: agents vs humans (breakdown + ratio)
- Recent transactions table (time, payer type, amount, resource, tx hash/link)

**Onboarding flow (first login):**
1. Connect Stripe account (Stripe OAuth redirect)
2. Enter Base wallet address
3. Copy API key → paste into middleware config

**Settings:**
- View/regenerate API key
- Stripe Connect account status
- Base wallet address

### Tone
- Terse and technical — developers, not end users
- No empty states with illustrations — show the actual empty table
- Error messages: specific (`"Stripe account not connected — complete onboarding"`) not generic (`"Something went wrong"`)

## Design System

Not specified yet — use a minimal component library (shadcn/ui or similar) to move fast. No custom design system for MVP.
