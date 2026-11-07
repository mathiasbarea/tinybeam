// What the collector derives on its own: device and browser from the user agent (and Client Hints),
// where the visit came from, campaign parameters and click IDs from the page URL, and country from the
// headers that common hosts and CDNs add.

// Ordered: the first match wins (Edge and Opera also say "Chrome", Chrome also says "Safari").
const BROWSERS = [
  [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
  [/(?:OPR|Opera)\/([\d.]+)/, 'Opera'],
  [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
  [/(?:Firefox|FxiOS)\/([\d.]+)/, 'Firefox'],
  [/(?:Chrome|CriOS)\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari\//, 'Safari'],
  [/(?:MSIE |Trident\/.*rv:)([\d.]+)/, 'Internet Explorer'],
];
const SYSTEMS = [
  [/Windows NT ([\d.]+)/, 'Windows'],
  [/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/, 'iOS'],
  [/Android ([\d.]+)/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X ([\d_.]+)/, 'macOS'],
  [/Linux/, 'Linux'],
];

const major = version => (version ? version.replace(/_/g, '.').split('.').slice(0, 2).join('.') : null);

// { device, browser, browser_version, os, os_version }. Client Hints, when the browser sends them, win
// over the user agent for the platform and mobile flag.
export function parseUserAgent(ua, headers) {
  ua = ua || '';
  const result = { device: 'desktop', browser: 'Other', browser_version: null, os: 'Other', os_version: null };
  for (const [pattern, name] of BROWSERS) {
    const m = ua.match(pattern);
    if (m) { result.browser = name; result.browser_version = major(m[1]); break; }
  }
  for (const [pattern, name] of SYSTEMS) {
    const m = ua.match(pattern);
    if (m) { result.os = name; result.os_version = major(m[1]); break; }
  }
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) result.device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android|Windows Phone/.test(ua)) result.device = 'mobile';
  const platform = headers && headers.get('sec-ch-ua-platform');
  if (platform) result.os = platform.replace(/"/g, '').replace('Chrome OS', 'ChromeOS');
  const mobile = headers && headers.get('sec-ch-ua-mobile');
  if (mobile === '?1' && result.device === 'desktop') result.device = 'mobile';
  return result;
}

const AI_ASSISTANTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|claude\.ai|meta\.ai|poe\.com|you\.com|chat\.deepseek\.com|chat\.mistral\.ai|grok\.com|kagi\.com)$/;
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z]+|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|seznam\.cz)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|reddit\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|threads\.net|bsky\.app|mastodon\.social|news\.ycombinator\.com|whatsapp\.com|t\.me|discord\.com)$/;
const EMAIL = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com)$/;

export const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'];
export const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];

// Campaign parameters and the first click ID found in the page URL.
export function campaign(pageUrl) {
  const out = {};
  for (const key of CAMPAIGN_KEYS) out[key] = pageUrl.searchParams.get(key) || null;
  out.click_id_type = null;
  out.click_id = null;
  for (const key of CLICK_IDS) {
    const value = pageUrl.searchParams.get(key);
    if (value) { out.click_id_type = key; out.click_id = value; break; }
  }
  return out;
}

// direct | internal | paid | email | ai_assistant | search | social | referral
export function classifyReferrer(referrer, pageUrl, fromCampaign) {
  const medium = (fromCampaign.utm_medium || '').toLowerCase();
  if (fromCampaign.click_id || /^(cpc|ppc|paid|paidsearch|paid_social|paidsocial|display|cpm)/.test(medium)) return 'paid';
  if (/^e-?mail|newsletter/.test(medium)) return 'email';
  let host = null;
  try { host = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : null; } catch { /* not a URL */ }
  if (!host) return medium === 'social' ? 'social' : fromCampaign.utm_source ? 'referral' : 'direct';
  if (host === pageUrl.hostname.replace(/^www\./, '')) return 'internal';
  if (AI_ASSISTANTS.test(host)) return 'ai_assistant';
  if (EMAIL.test(host)) return 'email';
  if (SEARCH.test(host)) return 'search';
  if (SOCIAL.test(host) || medium === 'social') return 'social';
  return 'referral';
}

// Country, region and city from headers set by common hosts and CDNs; null where none is present.
export function geoFromHeaders(headers) {
  const first = names => {
    for (const name of names) {
      const value = headers.get(name);
      if (value && value !== 'XX') return decodeURIComponent(value);
    }
    return null;
  };
  return {
    country: first(['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'fastly-geo-country']),
    region: first(['x-vercel-ip-country-region', 'cloudfront-viewer-country-region']),
    city: first(['x-vercel-ip-city', 'cloudfront-viewer-city']),
  };
}
