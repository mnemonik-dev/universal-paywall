'use strict';

// peertube-plugin-universal-paywall
//
// Registers PeerTube's `action:api.video.viewed` server hook and reports each view
// as a metered charge to the Universal Paywall facilitator. PeerTube has no native
// view webhook, so this published plugin is the attachment point (no core fork).
// The enabling upstream change (req.rawBody, PR #6300) already landed.
//
// Settings (Admin -> Plugins -> Universal Paywall):
//   facilitator-url, facilitator-api-key  — where to report charges
//   price-micro-usdc                       — per-view price (micro-USDC)
//   viewer-wallets                         — JSON: payer key -> 0x wallet (the registry)
//   channel-wallets                        — JSON: channelId -> 0x wallet
//
// Payer identity: `action:api.video.viewed` fires for anonymous views, so the
// payer key is taken from an `x-payer-user` header (stamped by a viewer client /
// the browser-extension adaptor); unknown payers are metered-and-skipped.

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch (_e) {
    return {};
  }
}

async function register({ registerHook, registerSetting, settingsManager }) {
  const settings = [
    ['facilitator-url', 'Facilitator URL'],
    ['facilitator-api-key', 'Facilitator API key'],
    ['price-micro-usdc', 'Price per view (micro-USDC)'],
    ['viewer-wallets', 'Viewer wallet map (JSON: payerKey -> 0x...)'],
    ['channel-wallets', 'Channel wallet map (JSON: channelId -> 0x...)'],
  ];
  for (const [name, label] of settings) {
    registerSetting({ name, label, type: 'input', private: true });
  }

  const { createReporter, mapResolver } = await import('@universal-paywall/integrations');
  const get = (k) => settingsManager.getSetting(k);

  registerHook({
    target: 'action:api.video.viewed',
    handler: async ({ video, req }) => {
      const facilitatorUrl = await get('facilitator-url');
      const apiKey = await get('facilitator-api-key');
      if (!facilitatorUrl || !apiKey) return; // not configured yet

      const reporter = createReporter({
        facilitatorUrl,
        apiKey,
        resolvePayer: mapResolver(safeJson(await get('viewer-wallets'))),
        resolveCreator: mapResolver(safeJson(await get('channel-wallets'))),
      });

      const header = req && req.headers && req.headers['x-payer-user'];
      const payerKey = (Array.isArray(header) ? header[0] : header) || 'anonymous';

      // The hook's `video` is an MVideoImmutable (id, url, uuid, remote, isLocal) —
      // it does NOT carry channelId. Key the creator on channelId when present,
      // else the video id (map it in channel-wallets, or via a video->channel
      // resolver for channel-level payout).
      const creatorKey = String(video.channelId != null ? video.channelId : video.id);

      await reporter.report({
        payerKey,
        creatorKey,
        amount: BigInt((await get('price-micro-usdc')) || '1000'),
        ref: `peertube:${video.uuid}:${Date.now()}`,
      });
    },
  });
}

async function unregister() {
  return Promise.resolve();
}

module.exports = { register, unregister };
