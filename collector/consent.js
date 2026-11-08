// Consent (docs/spec.md, section 5): each request gets a consent state for analytics (`consent`) and for
// advertising destinations (`ads_consent`), from the visitor's decision, Global Privacy Control, the
// visitor's country and the site's settings. The state decides the identity: a stable ID, the daily
// hash, or none.

// EU and EEA, United Kingdom, Switzerland.
export const CONSENT_REGIONS = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH'];

// mode: `region` (ask where `regions` require it), `all` (ask everyone), `anonymous` (never ask, never a
// stable ID) or `full` (never ask, stable ID everywhere). onRefusal: `count` (without an identifier) or
// `drop`. banner: whether the site uses Tinybeam's banner (otherwise its own, through tinybeam.consent).
export const CONSENT_DEFAULTS = { mode: 'region', regions: CONSENT_REGIONS, onRefusal: 'count', banner: false, ads: false };

export const consentSettings = site => ({ ...CONSENT_DEFAULTS, ...((site && site.consent) || {}) });

// Whether consent is required for a visitor from `country` (an unknown country counts as requiring it).
export function consentRequired(settings, country) {
  if (settings.mode === 'all' || settings.mode === 'anonymous') return true;
  if (settings.mode === 'full') return false;
  return !country || settings.regions.includes(String(country).toUpperCase());
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// A decision as kept in the tb_c cookie and sent as `c`: two digits, analytics then ads ("10": analytics
// granted, ads refused). "--" marks a visitor who needs no decision (a region where consent isn't required),
// so the script doesn't ask again; it is not a decision.
export const parseDecision = value => (/^[01]{2}$/.test(value || '') ? { analytics: value[0] === '1', ads: value[1] === '1' } : null);
export const formatDecision = ({ analytics, ads }) => `${analytics ? 1 : 0}${ads ? 1 : 0}`;

// Stable IDs: the collector's and the endpoint's are random base-36 or hex text; nothing else is accepted.
export const validId = value => typeof value === 'string' && /^[a-z0-9]{16,40}$/.test(value);
export const newStableId = () => [...crypto.getRandomValues(new Uint32Array(4))].map(x => x.toString(36)).join('');

// The consent state of one request. `decision` is the visitor's ({ analytics, ads }) or null.
export function consentState({ settings, country, decision, gpc }) {
  const required = consentRequired(settings, country);
  const state = choice => (decision ? (choice ? 'granted' : 'denied') : gpc ? 'gpc' : required ? 'pending' : 'not_required');
  const consent = settings.mode === 'anonymous' && !decision ? (gpc ? 'gpc' : 'pending') : state(decision && decision.analytics);
  return {
    required,
    consent,
    ads_consent: settings.mode === 'anonymous' && !decision ? (gpc ? 'gpc' : 'pending') : state(decision && decision.ads),
    // Stable ID only with consent, or where it isn't required.
    stable: consent === 'granted' || consent === 'not_required',
    // No identifier at all: a refusal, or GPC where consent is required.
    anonymousOnly: consent === 'denied' || (consent === 'gpc' && required),
  };
}

// What the script needs to know: `pending` means "ask" (show the banner); `none`, nothing to ask and no
// stable ID to create (a site that never asks and stays anonymous, or GPC where consent isn't required).
export function scriptState(settings, state) {
  if (state.consent === 'gpc') return state.required ? 'denied' : 'none';
  if (state.consent === 'pending' && settings.mode === 'anonymous') return 'none';
  return state.consent;
}

const YEAR = 395 * 86400; // 13 months
export const COOKIE_AGE = { id: YEAR, decision: 182 * 86400, notRequired: 86400 };

export function cookieHeader(name, value, maxAge, { secure = true, httpOnly = true } = {}) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`;
}
