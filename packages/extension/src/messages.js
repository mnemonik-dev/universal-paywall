// Message contract shared by the background handler, the page bridge, and any
// external extension that wants paid fetches via the installed Universal Paywall
// extension. Plain constants so both ends agree without a build step.

export const UP_STATUS = 'up:status';
export const UP_ENSURE_GRANT = 'up:ensureGrant';
export const UP_FETCH = 'up:fetch';

/** @typedef {{ type: 'up:status' }} StatusMessage */
/** @typedef {{ type: 'up:ensureGrant', req: object }} EnsureGrantMessage */
/** @typedef {{ type: 'up:fetch', url: string, init?: object }} FetchMessage */
/** @typedef {StatusMessage | EnsureGrantMessage | FetchMessage} UpMessage */

export const status = () => ({ type: UP_STATUS });
export const ensureGrant = (req) => ({ type: UP_ENSURE_GRANT, req });
export const fetchPaid = (url, init) => ({ type: UP_FETCH, url, ...(init ? { init } : {}) });
