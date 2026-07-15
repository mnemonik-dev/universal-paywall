// Content script: exposes a minimal `window.universalPaywall` to the page and
// relays its calls to the background worker via chrome.runtime.sendMessage. Lets
// in-page JS request a paid fetch without bundling the rail.

import { createBridge } from './bridge.js';
import { UP_FETCH, UP_STATUS } from './messages.js';

/* global chrome, window */
if (typeof chrome !== 'undefined' && chrome.runtime && typeof window !== 'undefined') {
  const bridge = createBridge((message) => chrome.runtime.sendMessage(message));
  // Only expose the read + paid-fetch surface to pages (no grant management).
  window.universalPaywall = {
    upFetch: (url, init) => bridge.upFetch(url, init),
    status: () => bridge.status(),
    _supports: [UP_FETCH, UP_STATUS],
  };
  window.dispatchEvent(new Event('universalpaywall#ready'));
}
