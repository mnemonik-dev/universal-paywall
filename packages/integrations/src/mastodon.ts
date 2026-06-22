/**
 * Fediverse — Mastodon donation-campaign **provider** (not a metered sidecar).
 *
 * Mastodon's `Api::V1::DonationCampaignsController` fetches an external URL
 * (`DONATION_CAMPAIGNS_URL`), caches the JSON for 1h, and renders it as the
 * instance donation banner. We fill that sanctioned slot — no fork change. The
 * campaign's `donation_url` points at the Universal Paywall stake/checkout flow,
 * so "donations" settle through the rail (agent -> facilitator -> StakeVault).
 *
 * Contract verified against
 * `mastodon/app/controllers/api/v1/donation_campaigns_controller.rb` +
 * `mastodon/spec/requests/api/v1/donation_campaigns_spec.rb`:
 *  - request:  `GET <url>?platform=web&seed=<int>&locale=<l>` (+ `environment`)
 *  - response: 200 with the campaign JSON, or 204 to show no banner
 *  - the campaign's `locale` MUST equal the requested `locale` (cache key is
 *    `id:locale`, request key `seed:locale`), so we echo it.
 */

/** Currency -> preset amounts (minor or major units; Mastodon renders them as-is). */
export type CampaignAmounts = {
  one_time?: Record<string, number[]>;
  monthly?: Record<string, number[]>;
};

/** The campaign template an operator configures, minus the per-request `locale`. */
export interface CampaignTemplate {
  id: string;
  banner_message: string;
  banner_button_text?: string;
  donation_message?: string;
  donation_button_text?: string;
  donation_success_post?: string;
  amounts?: CampaignAmounts;
  default_currency?: string;
  /** Where the donor goes to stake + grant; settles through the rail. */
  donation_url: string;
}

/** The JSON Mastodon caches + renders (template + echoed locale). */
export interface DonationCampaign extends CampaignTemplate {
  locale: string;
}

export interface DonationCampaignOptions {
  /** The configured campaign, or null to serve no banner (204). */
  campaign: CampaignTemplate | null;
  /** Locale to use when Mastodon sends none. Default `en`. */
  defaultLocale?: string;
}

/** The query params Mastodon appends to the provider URL. */
export interface DonationCampaignQuery {
  platform?: string | null;
  seed?: string | null;
  locale?: string | null;
  environment?: string | null;
}

/**
 * Builds the campaign payload for one Mastodon request, echoing the requested
 * locale. Returns null when no campaign is configured (the route maps that to a
 * 204, matching Mastodon's "no banner" path).
 */
export function buildDonationCampaign(
  opts: DonationCampaignOptions,
  query: DonationCampaignQuery = {},
): DonationCampaign | null {
  if (opts.campaign === null) return null;
  const locale = query.locale !== null && query.locale !== undefined && query.locale !== ''
    ? query.locale
    : (opts.defaultLocale ?? 'en');
  return { ...opts.campaign, locale };
}
