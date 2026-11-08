// Tinybeam collector: receives batches from the browser script, validates and enriches them, and writes
// records to a storage adapter. It is built only on web-standard APIs (Request, Response, URL,
// crypto.subtle), so the same code runs on Node.js, Deno, Bun, Cloudflare Workers and other runtimes.
// Platform adapters (node.js, cloudflare.js) only translate their requests into
// handle(request, context), where context carries what the platform knows about the client:
//   { ip, country, region, city, verifiedBotCategory, waitUntil(promise) }
import { classifyBot } from './bots.js';
import { renderBanner } from './banner.js';
import { COOKIE_AGE, consentSettings, consentState, cookieHeader, formatDecision, parseCookies, parseDecision, scriptState, validId } from './consent.js';
import { campaign, classifyReferrer, geoFromHeaders, parseUserAgent } from './enrich.js';
import { memoryStorage } from './storage.js';

// Months a site's records are kept by default (docs/spec.md, section 7, Data retention).
export const RETENTION_MONTHS = 24;

const DEFAULTS = {
  path: '/tb', // the script posts to `${path}/e`; the noscript pixel is `${path}/n`
  searchParams: ['q', 's', 'query'],
  downloads: ['pdf', 'zip', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'mp3', 'mp4', 'mov',
    'dmg', 'exe', 'msi', 'apk', 'epub', 'rar', '7z', 'gz'],
  sessionTimeout: 30 * 60 * 1000,
  maxBody: 16 * 1024,
  maxEvents: 50,
  maxProps: 25, // per event; keys up to 40 characters, string values up to 500
  // The browser script, served from the collector: its code (served as `${path}/tinybeam.js`), or the
  // bundles by file name ({ 'tinybeam.js': code, 'tinybeam-ids.js': code }).
  script: null,
  secureCookies: true, // the visitor cookies (consent, stable ID) carry Secure; off only for plain-HTTP testing
  // Months a site's records are kept, unless the site sets its own (`site.retention`). Older ones are
  // deleted about once a day, when the site records something.
  retention: RETENTION_MONTHS,
};

const MONTH = 30.4375 * 864e5;

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

// Sessions kept in memory: a session ends after `timeout` without events, or on end() (tinybeam.reset).
// move() carries a session to a new key, when a visitor who accepts consent goes from the daily hash to a
// stable ID mid-session. Several instances need a shared store with the same methods.
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
    end(key) {
      sessions.delete(key);
    },
    move(from, to) {
      const session = sessions.get(from);
      if (!session) return;
      sessions.set(to, session);
      sessions.delete(from);
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
export function cleanProps(props, max, { allowNull = false } = {}) {
  const out = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (count >= max || !/^[A-Za-z_]\w{0,39}$/.test(key)) continue;
    if (value === null && allowNull) out[key] = null;
    else if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else continue;
    count++;
  }
  return out;
}

const SETTERS = ['$page', '$session', '$user', '$reset'];
// `is` in a batch: where the script found the stable ID (docs/spec.md, section 5). Without it, the
// collector keeps the ID in its own cookies.
const ID_STORES = { e: 'endpoint', s: 'script' };

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
  const visitorCookie = (name, value, maxAge, httpOnly = true) => cookieHeader(name, value, maxAge, { secure: config.secureCookies, httpOnly });

  // The site when the request may be recorded for it, or null: the site must exist, and both the page URL
  // and the Origin header (when present) must be one of its origins.
  const resolveSite = async (siteId, pageUrl, origin) => {
    const site = siteId ? await findSite(siteId) : null;
    if (!site) return null;
    const allowed = site.origins || [];
    if (!allowed.includes(pageUrl.origin) || (origin && !allowed.includes(origin))) return null;
    return site;
  };

  // Who the visitor is, as far as their consent allows (docs/spec.md, section 5). `via` is how the script
  // keeps the stable ID: { store: 'endpoint' | 'script', id, decision } from the batch, or null when the
  // collector keeps it in its own cookies. Returns the identity fields, the cookies to set (when `respond`)
  // and the consent state.
  const identify = async ({ request, context, site, geo, ua, time, bot, via, decision: given, respond }) => {
    const day = new Date(time).toISOString().slice(0, 10);
    const hash = await sha256(`${await salt(day)}|${site.id}|${context.ip || ''}|${ua}`);
    if (bot) return { fields: { aid: hash, sid: null, consent: null, ads_consent: null, id_store: null }, cookies: [], hash };
    const settings = consentSettings(site);
    const cookies = parseCookies(request.headers.get('cookie'));
    const decision = given || parseDecision(via ? via.decision : cookies.tb_c);
    const state = consentState({ settings, country: geo.country, decision, gpc: request.headers.get('sec-gpc') === '1' });
    const set = [];
    let aid = state.anonymousOnly ? null : hash;
    let idStore = null;
    if (state.stable && via) {
      if (validId(via.id)) { aid = via.id; idStore = via.store; }
    } else if (state.stable) {
      // The collector keeps the ID: renewed on each response, and created from the day's hash, so the
      // visitor's records today and the cookie's later ones are the same visitor, and a browser that
      // drops the cookie still counts once a day instead of once per request.
      aid = validId(cookies.tb_id) ? cookies.tb_id : hash;
      idStore = 'collector';
      if (respond) set.push(visitorCookie('tb_id', aid, COOKIE_AGE.id));
      if (respond && !decision && cookies.tb_c !== '--') set.push(visitorCookie('tb_c', '--', COOKIE_AGE.notRequired, false));
    } else if (!via && cookies.tb_id && respond) {
      set.push(visitorCookie('tb_id', '', 0)); // consent withdrawn or no longer allowed
    }
    return {
      fields: { aid, sid: aid ? sessions.touch(`${site.id}|${aid}`, time) : null, consent: state.consent, ads_consent: state.ads_consent, id_store: idStore },
      cookies: set,
      state,
      settings,
      hash,
    };
  };

  // Fields shared by every record from one client request, and what identify() decided.
  const clientFields = async (request, context, site, extra = {}) => {
    const ua = request.headers.get('user-agent') || '';
    const time = now();
    const geo = context.country !== undefined
      ? { country: context.country || null, region: context.region || null, city: context.city || null }
      : geoFromHeaders(request.headers);
    const bot = classifyBot(ua, { webdriver: extra.webdriver, verifiedCategory: context.verifiedBotCategory });
    const who = await identify({ request, context, site, geo, ua, time, bot, via: extra.via || null, decision: extra.decision, respond: extra.respond });
    return {
      fields: {
        received_at: time,
        site: site.id,
        ...who.fields,
        ...parseUserAgent(ua, request.headers),
        ...geo,
        traffic: bot ? 'bot' : 'human',
        bot_name: bot ? bot.name : null,
        bot_category: bot ? bot.category : null,
        bot_verified: bot ? bot.verified : null,
      },
      who,
    };
  };
  // A refusal where the site chose not to measure refusals: nothing is recorded.
  const dropped = who => who.state && who.state.anonymousOnly && who.settings.onRefusal === 'drop';

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

  // Data retention: at most once a day per site, delete what is older than the site's retention.
  const pruned = new Map(); // site ID -> when its old records were last deleted
  const prune = async id => {
    const time = now();
    if (!storage.prune || !id || time - (pruned.get(id) || 0) < 864e5) return;
    pruned.set(id, time);
    const site = await findSite(id);
    await storage.prune(id, time - ((site && site.retention) || config.retention) * MONTH);
  };

  const store = (records, context) => {
    if (!records.length) return;
    const done = Promise.resolve(storage.write(records))
      .catch(error => console.error('tinybeam: storage write failed', error))
      .then(() => prune(records[0].site).catch(error => console.error('tinybeam: deleting old records failed', error)));
    // Where the platform can finish work after responding, the response doesn't wait for storage.
    if (context.waitUntil) context.waitUntil(done);
    else return done;
  };

  const corsHeaders = origin => (origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
  const withCookies = (headers, cookies) => {
    const out = new Headers(headers);
    for (const value of cookies) out.append('Set-Cookie', value);
    return out;
  };
  const readJson = async request => {
    const text = await request.text();
    if (text.length > config.maxBody) return { error: new Response('Payload Too Large', { status: 413 }) };
    try { return { body: JSON.parse(text) }; } catch { return { error: new Response('Bad Request', { status: 400 }) }; }
  };
  const preflight = (origin, methods) => new Response(null, { status: 204, headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': 'Content-Type' } });

  async function collect(request, context) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return preflight(origin, 'POST');
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const { body, error } = await readJson(request);
    if (error) return error;
    const pageUrl = body && body.v === 1 && Array.isArray(body.e) && body.e.length <= config.maxEvents && httpUrl(body.u);
    if (!pageUrl) return new Response('Bad Request', { status: 400 });
    const site = await resolveSite(typeof body.s === 'string' ? body.s : null, pageUrl, origin);
    if (!site) return new Response('Forbidden', { status: 403 });

    const via = ID_STORES[body.is] ? { store: ID_STORES[body.is], id: body.i, decision: typeof body.c === 'string' ? body.c : null } : null;
    const { fields, who } = await clientFields(request, context, site, { webdriver: body.wd === 1, via, respond: true });
    const headers = withCookies(corsHeaders(origin), who.cookies);
    if (dropped(who)) return new Response(null, { status: 204, headers });
    const shared = {
      ...fields,
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
      if (!event || typeof event.n !== 'string') continue;
      // $page, $session, $user and $reset come from setPage / setSession / setUser / reset; they are
      // stored as kind "set" and applied to the whole page view, session or user when querying.
      if (SETTERS.includes(event.n)) {
        const raw = event.p && typeof event.p === 'object' ? event.p : {};
        const props = cleanProps(raw, config.maxProps, { allowNull: true });
        let uid = null;
        if (event.n === '$user' && 'id' in props) {
          uid = typeof props.id === 'string' || typeof props.id === 'number' ? String(props.id).slice(0, 200) : null;
          delete props.id;
        }
        records.push({ ...shared, kind: 'set', name: event.n, client_time: Number.isFinite(event.t) ? event.t : null, uid, props: event.n === '$reset' ? {} : props });
        // A reset starts a new session for what follows, in this batch and later ones.
        if (event.n === '$reset' && shared.sid) {
          sessions.end(`${site.id}|${shared.aid}`);
          shared.sid = sessions.touch(`${site.id}|${shared.aid}`, shared.received_at);
        }
        continue;
      }
      if (!/^[\w.:-]{1,64}$/.test(event.n)) continue;
      const raw = event.p && typeof event.p === 'object' ? event.p : {};
      const base = { ...shared, name: event.n, client_time: Number.isFinite(event.t) ? event.t : null };
      if (event.n === 'page_view') {
        // title and ref have their own columns; the rest are the site's properties.
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
    return new Response(null, { status: 204, headers });
  }

  // `${path}/c`: consent. GET ?s=&u=[&m=e|s] answers what the script needs to know (`{ "c": state }`,
  // section 5); POST { s, u, c, src, i?, is? } records a decision as a `$consent` record and, when the
  // collector keeps the ID, sets the decision and ID cookies.
  async function consent(request, context) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return preflight(origin, 'GET, POST');
    let input;
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      input = { s: params.get('s'), u: params.get('u'), is: params.get('m') };
    } else if (request.method === 'POST') {
      const { body, error } = await readJson(request);
      if (error) return error;
      input = body || {};
    } else return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    const pageUrl = httpUrl(input.u);
    const site = pageUrl && await resolveSite(typeof input.s === 'string' ? input.s : null, pageUrl, origin);
    if (!site) return new Response('Forbidden', { status: 403 });
    const mode = ID_STORES[input.is];
    const json = (data, cookies = []) => new Response(JSON.stringify(data), { headers: withCookies({ ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cookies) });

    if (request.method === 'GET') {
      const { who } = await clientFields(request, context, site, { via: mode ? { store: mode } : null, respond: true });
      return json({ c: who.state ? scriptState(who.settings, who.state) : 'none' }, who.cookies);
    }

    const decision = parseDecision(input.c);
    if (!decision) return new Response('Bad Request', { status: 400 });
    const cookies = parseCookies(request.headers.get('cookie'));
    const via = mode ? { store: mode, id: input.i } : null;
    const { fields, who } = await clientFields(request, context, site, { via, decision, respond: true });
    if (!who.state) return json({}); // bots don't decide
    const set = [...who.cookies];
    if (!via) set.push(visitorCookie('tb_c', formatDecision(decision), COOKIE_AGE.decision, false));
    // Accepting mid-session keeps the session: it moves from the daily hash to the stable ID.
    if (who.state.stable && fields.aid !== who.hash && !(validId(cookies.tb_id) && cookies.tb_id === fields.aid)) {
      sessions.move(`${site.id}|${who.hash}`, `${site.id}|${fields.aid}`);
      fields.sid = sessions.touch(`${site.id}|${fields.aid}`, fields.received_at);
    }
    const source = ['banner', 'api'].includes(input.src) ? input.src : 'api';
    // The proof of the decision. A refusal carries no identifier.
    await store([{
      ...fields,
      ...(who.state.stable ? {} : { aid: null, sid: null }),
      kind: 'set', name: '$consent', source: 'script', js: 'on', url: pageUrl.href, host: pageUrl.host, path: pageUrl.pathname,
      props: { analytics: decision.analytics, ads: decision.ads, source },
    }], context);
    return json({ c: scriptState(who.settings, who.state) }, set);
  }

  // GET `${path}/n?s=<site ID>` from the page's <noscript><img>: a page view with JavaScript off.
  // The page URL comes from the Referer header.
  async function noscript(request, context) {
    const pageUrl = httpUrl(request.headers.get('referer'));
    const site = pageUrl && await resolveSite(new URL(request.url).searchParams.get('s'), pageUrl, null);
    let cookies = [];
    if (site) {
      const { fields, who } = await clientFields(request, context, site, { respond: true });
      cookies = who.cookies;
      if (!dropped(who)) await store([{ ...fields, ...pageFields(pageUrl, null, null), kind: 'event', source: 'noscript', js: 'off', name: 'page_view', props: {} }], context);
    }
    return new Response(GIF, { headers: withCookies({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }, cookies) });
  }

  // GET `${path}/banner.js?s=<site ID>&l=<languages>[&f=1][&m=e|s]`: Tinybeam's consent banner with the
  // site's texts, when this visitor must be asked (or `f`, a "privacy settings" click); otherwise an empty
  // script, plus the cookies that say no decision is needed. The answer depends on the visitor, so it is
  // never cached.
  async function banner(request, context) {
    const params = new URL(request.url).searchParams;
    const site = await findSite(params.get('s'));
    if (!site) return new Response('Not Found', { status: 404 });
    const settings = consentSettings(site);
    let cookies = [];
    let show = settings.banner;
    if (show && params.get('f') !== '1') {
      const mode = ID_STORES[params.get('m')];
      const { who } = await clientFields(request, context, site, { via: mode ? { store: mode } : null, respond: true });
      cookies = who.cookies;
      show = Boolean(who.state) && scriptState(settings, who.state) === 'pending';
    }
    return new Response(show ? renderBanner(settings, params.get('l')) : '', { headers: withCookies({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, no-store' }, cookies) });
  }

  // Routes collector requests; anything else is a 404 (or, inside a site's own server, not ours to answer).
  async function handle(request, context = {}) {
    const { pathname } = new URL(request.url);
    if (pathname === `${config.path}/e`) return collect(request, context);
    if (pathname === `${config.path}/c`) return consent(request, context);
    if (pathname === `${config.path}/n`) return noscript(request, context);
    if (pathname === `${config.path}/banner.js`) return banner(request, context);
    const file = pathname.slice(config.path.length + 1);
    const code = typeof config.script === 'string' ? (file === 'tinybeam.js' ? config.script : null) : config.script && Object.hasOwn(config.script, file) ? config.script[file] : null;
    if (code) {
      return new Response(code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
    }
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
    const { fields, who } = await clientFields(request, context, site);
    const isHtml = (response.headers.get('content-type') || '').startsWith('text/html');
    if (fields.traffic === 'bot') {
      await store([{ ...fields, ...pageFields(pageUrl, request.headers.get('referer'), null), kind: 'bot', source: 'server', name: 'request', status: response.status, special_file: specialFile(pageUrl.pathname), props: {} }], context);
      return null;
    }
    if (!isHtml || response.status >= 300) return null;
    const pv = context.pv || crypto.randomUUID().replace(/-/g, '');
    if (!dropped(who)) await store([{ ...fields, ...pageFields(pageUrl, request.headers.get('referer'), null), kind: 'event', source: 'server', js: 'unknown', name: 'page_view', pv, status: response.status, props: {} }], context);
    return pv;
  }

  // For a collector in front of the site: the visitor's consent state for the script's data-consent
  // attribute (`pending` means show the banner), so the script doesn't have to ask.
  async function consentFor(request, context = {}) {
    const pageUrl = httpUrl(request.url);
    const site = pageUrl && await resolveSite(context.site, pageUrl, null);
    if (!site) return null;
    const { who } = await clientFields(request, context, site);
    return who.state ? scriptState(who.settings, who.state) : null;
  }

  return { handle, observe, consentFor, config };
}

// A new random site ID: 12 lowercase letters and digits.
export const newSiteId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

export { memoryStorage, sqlStorage, COLUMNS } from './storage.js';
export { classifyBot, BOTS } from './bots.js';
export { CONSENT_DEFAULTS, CONSENT_REGIONS } from './consent.js';
export { createIdEndpoint } from './endpoint.js';
