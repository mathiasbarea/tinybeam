// Tinybeam collector: receives batches from the browser script, validates and enriches them, and writes
// records to a storage adapter. It is built only on web-standard APIs (Request, Response, URL,
// crypto.subtle), so the same code runs on Node.js, Deno, Bun, Cloudflare Workers and other runtimes.
// Platform adapters (node.js, cloudflare.js) only translate their requests into
// handle(request, context), where context carries what the platform knows about the client:
//   { ip, country, region, city, verifiedBotCategory, waitUntil(promise) }
import { classifyBot } from './bots.js';
import { campaign, classifyReferrer, geoFromHeaders, parseUserAgent } from './enrich.js';
import { memoryStorage } from './storage.js';

const DEFAULTS = {
  path: '/tb', // the script posts to `${path}/e`; the noscript pixel is `${path}/n`
  searchParams: ['q', 's', 'query'],
  downloads: ['pdf', 'zip', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'mp3', 'mp4', 'mov',
    'dmg', 'exe', 'msi', 'apk', 'epub', 'rar', '7z', 'gz'],
  sessionTimeout: 30 * 60 * 1000,
  maxBody: 16 * 1024,
  maxEvents: 50,
  maxProps: 25, // per event; keys up to 40 characters, string values up to 500
};

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));

// Daily salt kept in memory: anonymous IDs can't be linked across days, and the salt is gone once the day
// changes. Several collector instances need a shared salt; pass `salt: async day => ...` for that.
export function dailySalt() {
  let current = { day: null, salt: null };
  return async day => {
    if (current.day !== day) current = { day, salt: crypto.randomUUID() };
    return current.salt;
  };
}

// Sessions kept in memory: a session ends after `timeout` without events. Several instances need a
// shared store with the same `touch(key, now)` method.
export function memorySessions(timeout) {
  const sessions = new Map();
  return {
    touch(key, now) {
      let session = sessions.get(key);
      if (!session || now - session.last > timeout) session = { sid: crypto.randomUUID(), last: now };
      session.last = now;
      sessions.set(key, session);
      if (sessions.size > 50_000) for (const [k, s] of sessions) if (now - s.last > timeout) sessions.delete(k);
      return session.sid;
    },
  };
}

const sha256 = async text => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
};

const specialFile = path =>
  path === '/robots.txt' ? 'robots.txt'
    : /^\/sitemap[\w-]*\.xml$/.test(path) ? 'sitemap'
      : /^\/llms(-full)?\.txt$/.test(path) ? 'llms.txt'
        : path.endsWith('.md') ? 'markdown'
          : null;

// Event properties as stored: a flat object of strings, finite numbers and booleans, with keys of letters,
// digits and underscores. Anything else is dropped, and long strings are cut, so a page can't fill the
// database with arbitrary data.
export function cleanProps(props, max) {
  const out = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (count >= max || !/^[A-Za-z_]\w{0,39}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else continue;
    count++;
  }
  return out;
}

const httpUrl = value => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch { return null; }
};

export function createCollector(options = {}) {
  const config = { ...DEFAULTS, ...options };
  // Every site has an ID, whether the collector is self-hosted for one site or hosted for many: the script
  // sends it (data-site) and the collector only accepts registered sites. `sites` is a list, or a function
  // `async id => site | null` for a registry kept elsewhere (a database, an admin UI).
  if (!config.sites) throw new Error('tinybeam: `sites` is required, for example [{ id, origins: [...] }]');
  const findSite = Array.isArray(config.sites)
    ? id => config.sites.find(site => site.id === id) || null
    : config.sites;
  const storage = config.storage || memoryStorage();
  const salt = config.salt || dailySalt();
  const sessions = config.sessions || memorySessions(config.sessionTimeout);
  const now = config.now || Date.now;

  // The site ID when the request may be recorded for it, or null: the site must exist, and both the page
  // URL and the Origin header (when present) must be one of its origins.
  const resolveSite = async (siteId, pageUrl, origin) => {
    const site = siteId ? await findSite(siteId) : null;
    if (!site) return null;
    const allowed = site.origins || [];
    if (!allowed.includes(pageUrl.origin) || (origin && !allowed.includes(origin))) return null;
    return site.id;
  };

  // Fields shared by every record from one client request.
  const clientFields = async (request, context, site, extra = {}) => {
    const ua = request.headers.get('user-agent') || '';
    const time = now();
    const geo = context.country !== undefined
      ? { country: context.country || null, region: context.region || null, city: context.city || null }
      : geoFromHeaders(request.headers);
    const bot = classifyBot(ua, { webdriver: extra.webdriver, verifiedCategory: context.verifiedBotCategory });
    const day = new Date(time).toISOString().slice(0, 10);
    const aid = await sha256(`${await salt(day)}|${site}|${context.ip || ''}|${ua}`);
    return {
      received_at: time,
      site,
      aid,
      sid: bot ? null : sessions.touch(`${site}|${aid}`, time),
      ...parseUserAgent(ua, request.headers),
      ...geo,
      traffic: bot ? 'bot' : 'human',
      bot_name: bot ? bot.name : null,
      bot_category: bot ? bot.category : null,
      bot_verified: bot ? bot.verified : null,
    };
  };

  const pageFields = (pageUrl, referrer, title) => {
    const fromCampaign = campaign(pageUrl);
    let referrerHost = null;
    try { referrerHost = referrer ? new URL(referrer).hostname : null; } catch { /* not a URL */ }
    return {
      url: pageUrl.href,
      host: pageUrl.host,
      path: pageUrl.pathname,
      title: title || null,
      referrer: referrer || null,
      referrer_host: referrerHost,
      referrer_type: classifyReferrer(referrer, pageUrl, fromCampaign),
      ...fromCampaign,
    };
  };

  const store = (records, context) => {
    if (!records.length) return;
    const done = Promise.resolve(storage.write(records)).catch(error => console.error('tinybeam: storage write failed', error));
    // Where the platform can finish work after responding, the response doesn't wait for storage.
    if (context.waitUntil) context.waitUntil(done);
    else return done;
  };

  const corsHeaders = origin => (origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});

  async function collect(request, context) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const text = await request.text();
    if (text.length > config.maxBody) return new Response('Payload Too Large', { status: 413 });
    let body;
    try { body = JSON.parse(text); } catch { return new Response('Bad Request', { status: 400 }); }
    const pageUrl = body && body.v === 1 && Array.isArray(body.e) && body.e.length <= config.maxEvents && httpUrl(body.u);
    if (!pageUrl) return new Response('Bad Request', { status: 400 });
    const site = await resolveSite(typeof body.s === 'string' ? body.s : null, pageUrl, origin);
    if (!site) return new Response('Forbidden', { status: 403 });

    const shared = {
      ...await clientFields(request, context, site, { webdriver: body.wd === 1 }),
      kind: 'event',
      source: 'script',
      js: 'on',
      pv: typeof body.pv === 'string' ? body.pv.slice(0, 64) : null,
      url: pageUrl.href,
      host: pageUrl.host,
      path: pageUrl.pathname,
      language: typeof body.l === 'string' ? body.l.slice(0, 35) : null,
      screen_w: Number.isFinite(body.sw) ? body.sw : null,
      screen_h: Number.isFinite(body.sh) ? body.sh : null,
      viewport_w: Number.isFinite(body.vw) ? body.vw : null,
      viewport_h: Number.isFinite(body.vh) ? body.vh : null,
      tz: typeof body.tz === 'string' ? body.tz.slice(0, 64) : null,
      tx: typeof body.tx === 'string' ? body.tx.slice(0, 1) : null,
      cap: body.cap && typeof body.cap === 'object' ? body.cap : null,
      automation: body.wd === 1,
    };

    const records = [];
    for (const event of body.e) {
      if (!event || typeof event.n !== 'string' || !/^[\w.:-]{1,64}$/.test(event.n)) continue;
      const raw = event.p && typeof event.p === 'object' ? event.p : {};
      const base = { ...shared, name: event.n, client_time: Number.isFinite(event.t) ? event.t : null };
      if (event.n === 'page_view') {
        // title and ref have their own columns; the rest are the site's properties (tinybeam.set).
        const { title, ref, ...rest } = raw;
        const props = cleanProps(rest, config.maxProps);
        records.push({ ...base, ...pageFields(pageUrl, typeof ref === 'string' ? ref.slice(0, 2000) : null, typeof title === 'string' ? title.slice(0, 300) : null), props });
        const key = config.searchParams.find(k => pageUrl.searchParams.get(k));
        if (key) records.push({ ...base, name: 'search', props: { ...props, term: pageUrl.searchParams.get(key).slice(0, 200) } });
      } else if (event.n === 'download') {
        const target = httpUrl(raw.url);
        const ext = target && (target.pathname.match(/\.(\w+)$/) || [])[1];
        if (ext && config.downloads.includes(ext.toLowerCase())) {
          records.push({ ...base, props: { ...cleanProps(raw, config.maxProps), url: target.href.slice(0, 2000), ext: ext.toLowerCase() } });
        }
      } else {
        records.push({ ...base, props: cleanProps(raw, config.maxProps) });
      }
    }
    await store(records, context);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // GET `${path}/n?s=<site ID>` from the page's <noscript><img>: a page view with JavaScript off.
  // The page URL comes from the Referer header.
  async function noscript(request, context) {
    const pageUrl = httpUrl(request.headers.get('referer'));
    const site = pageUrl && await resolveSite(new URL(request.url).searchParams.get('s'), pageUrl, null);
    if (site) {
      const fields = await clientFields(request, context, site);
      await store([{ ...fields, ...pageFields(pageUrl, null, null), kind: 'event', source: 'noscript', js: 'off', name: 'page_view', props: {} }], context);
    }
    return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
  }

  // Routes collector requests; anything else is a 404 (or, inside a site's own server, not ours to answer).
  async function handle(request, context = {}) {
    const { pathname } = new URL(request.url);
    if (pathname === `${config.path}/e`) return collect(request, context);
    if (pathname === `${config.path}/n`) return noscript(request, context);
    return new Response('Not Found', { status: 404 });
  }

  // For a collector in front of the site: records a request the site answered. Bots are recorded for
  // every request passed in; humans only for HTML pages, as server-side page views with js "unknown" (the
  // script, when it runs, adds its own records with the same `pv`). Returns the page view ID to give the
  // script (data-pv), or null. `context.site` names the site.
  async function observe(request, response, context = {}) {
    const pageUrl = httpUrl(request.url);
    if (!pageUrl || request.method !== 'GET') return null;
    const site = await resolveSite(context.site, pageUrl, null);
    if (!site) return null;
    const fields = await clientFields(request, context, site);
    const isHtml = (response.headers.get('content-type') || '').startsWith('text/html');
    if (fields.traffic === 'bot') {
      await store([{ ...fields, ...pageFields(pageUrl, request.headers.get('referer'), null), kind: 'bot', source: 'server', name: 'request', status: response.status, special_file: specialFile(pageUrl.pathname), props: {} }], context);
      return null;
    }
    if (!isHtml || response.status >= 300) return null;
    const pv = context.pv || crypto.randomUUID().replace(/-/g, '');
    await store([{ ...fields, ...pageFields(pageUrl, request.headers.get('referer'), null), kind: 'event', source: 'server', js: 'unknown', name: 'page_view', pv, status: response.status, props: {} }], context);
    return pv;
  }

  return { handle, observe, config };
}

// A new random site ID: 12 lowercase letters and digits.
export const newSiteId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

export { memoryStorage, sqlStorage, COLUMNS } from './storage.js';
export { classifyBot, BOTS } from './bots.js';
