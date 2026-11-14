// The portal: server-rendered pages for setting up the owner account, signing in and managing sites. Like
// the collector, it is a web-standard handler (Request in, Response out) and needs no JavaScript in the
// browser. Pages live under `basePath`; the owner mounts it on whatever URL they want.
import { BANNER_TEXTS, TEXT_KEYS, bannerLanguages, bannerTexts } from '../collector/banner.js';
import { CONSENT_REGIONS, consentSettings } from '../collector/consent.js';
import { hashPassword, verifyPassword } from './auth.js';
import { FAVICON, MARK } from './brand.js';
import { HOSTS, WAYS, checkInstall, installSteps } from './install.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? (values[i] && values[i].raw !== undefined ? values[i].raw : escape(values[i])) : ''), '');
const raw = text => ({ raw: text });

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--line:#ddd;--card:#fff;--accent:#2457d6;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--card:#1a1a1a;--accent:#7aa2ff;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
header a{color:inherit;text-decoration:none;font-weight:600}header>a{display:inline-flex;align-items:center;gap:8px}main{max-width:760px;margin:0 auto;padding:24px 20px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:28px 0 8px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
label{display:block;margin:12px 0 4px;font-weight:600}input,textarea,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit;font:inherit}
button,.button{display:inline-block;margin-top:14px;padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none}
button.link{background:none;color:inherit;padding:0;margin:0;text-decoration:underline}button.danger{background:var(--danger)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.error{color:var(--danger)}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 4px;border-bottom:1px solid var(--line)}
.tag{font-size:12px;padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
main.wide{max-width:1100px}nav.tabs{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 16px;border-bottom:1px solid var(--line)}
nav.tabs a{padding:6px 0;color:var(--muted);text-decoration:none}nav.tabs a.on{color:var(--fg);border-bottom:2px solid var(--accent)}
.ranges a{margin-right:10px}.ranges a.on{font-weight:700;color:var(--fg)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:12px}.grid .card{margin:0;min-width:0}.card h3{margin:0 0 8px;font-size:15px}
.bar{table-layout:fixed}.bar td{border:0;padding:3px 0;overflow-wrap:anywhere}.bar td:last-child{text-align:right;color:var(--muted);width:90px}.bar .fill{height:4px;background:var(--accent);border-radius:2px;margin-top:2px;opacity:.7}
.note{font-size:13px;color:var(--muted)}a{color:var(--accent)}
`;

// Origins from a textarea, one per line: "https://example.com", no path. Returns [origins, error].
export function parseOrigins(text) {
  const origins = [];
  for (const line of String(text || '').split(/\s+/).filter(Boolean)) {
    let url;
    try { url = new URL(line); } catch { return [null, `"${line}" is not a URL`]; }
    if (!/^https?:$/.test(url.protocol)) return [null, `"${line}" must start with http:// or https://`];
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins.length ? [origins, null] : [null, 'Add at least one origin'];
}

const CONSENT_STATES = ['granted', 'not_required', 'pending', 'denied', 'gpc', 'unknown'];
const CONSENT_LABELS = { granted: 'Accepted', not_required: 'Not required (region)', pending: 'Not decided yet', denied: 'Refused', gpc: 'Global Privacy Control', unknown: 'Not recorded' };
const RANGES = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };
const number = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const duration = ms => (ms == null ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function createPortal({ store, queries, basePath = '/portal', collectorPath = '/tb', secureCookies = true, setupToken = null, now = Date.now }) {
  const COOKIE = 'tb_session';
  const url = path => basePath + path;
  const failures = new Map(); // email -> { count, until }: slows down password guessing

  const page = (title, body, user, status = 200, headers = {}, wide = false) => new Response(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tinybeam</title><link rel="icon" href="${FAVICON}" type="image/svg+xml"><style>${raw(CSS)}</style></head><body>
<header><a href="${url('/')}">${raw(MARK)}Tinybeam</a>${raw(user ? html`<form method="post" action="${url('/logout')}"><span class="muted">${user.email}</span> &nbsp;<button class="link">Sign out</button></form>` : '')}</header>
<main class="${wide ? 'wide' : ''}">${raw(body)}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...headers } });

  const redirect = (path, headers = {}) => new Response(null, { status: 303, headers: { Location: url(path), ...headers } });
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=${basePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const tokenFrom = request => {
    const match = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return match ? match[1] : null;
  };
  // Form posts must come from the portal's own pages (on top of SameSite cookies).
  const sameOrigin = request => {
    const origin = request.headers.get('origin');
    if (origin) return origin === new URL(request.url).origin;
    return request.headers.get('sec-fetch-site') !== 'cross-site';
  };

  const form = async request => Object.fromEntries(await request.formData());

  const authForm = (title, action, intro, error, email = '', token = '') => html`
<h1>${title}</h1><p class="muted">${intro}</p>
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(action)}" class="card">
${raw(token ? html`<input type="hidden" name="token" value="${token}">` : '')}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${email}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${action === '/setup' ? 'new-password' : 'current-password'}" minlength="${action === '/setup' ? 12 : 1}" required>
<button>${title}</button></form>`;

  const siteForm = (action, site, error) => html`
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(action)}" class="card">
<label for="name">Name</label><input id="name" name="name" required maxlength="100" value="${site.name || ''}">
<label for="origins">Origins</label>
<textarea id="origins" name="origins" rows="3" required placeholder="https://example.com">${(site.origins || []).join('\n')}</textarea>
<p class="muted">Where the site's pages are served from, one per line. Events from other origins are rejected.</p>
${raw(site.id ? html`<label><input type="checkbox" name="paused" value="1" style="width:auto" ${raw(site.paused ? 'checked' : '')}> Paused (stop recording)</label>` : '')}
<button>${site.id ? 'Save' : 'Add site'}</button></form>`;

  // Installation: one question (where the site is hosted), then only the steps that fit, and a check of how
  // recent page views kept the stable ID (portal/install.js).
  const install = (site, hostKey, origin, check) => {
    const base = `/sites/${site.id}`;
    const host = HOSTS.find(h => h.key === hostKey);
    const steps = host ? installSteps(host.key, site, { origin, path: collectorPath, banner: consentSettings(site).banner }) : [];
    return html`
<h2>Install</h2>
<form method="post" action="${url(`${base}/install`)}" class="card">
<label for="host">Where is the site hosted?</label>
<select id="host" name="host">${raw(`<option value="">Choose…</option>` + HOSTS.map(h => html`<option value="${h.key}" ${raw(h.key === hostKey ? 'selected' : '')}>${h.label}</option>`).join(''))}</select>
<button>Show how to install</button></form>
${raw(steps.map((step, i) => html`<div class="card"><h3>${i + 1}. ${step.title}</h3>${raw(step.text ? html`<p>${step.text}</p>` : '')}${raw(step.code ? html`<pre>${step.code}</pre>` : '')}</div>`).join(''))}
${raw(host ? html`<p class="note">Returning visitors are recognized for ${WAYS[host.way].lifetime}.</p>` : '')}
${raw(check ? html`<p class="${check.ok === false ? 'error' : 'note'}">${check.text}</p>` : '')}`;
  };

  const MODES = [
    ['region', 'Ask in the regions that require it, measure fully elsewhere'],
    ['all', 'Ask everyone, wherever they are'],
    ['anonymous', 'Never ask: anonymous measurement only, no stable ID'],
    ['full', 'Never ask: full measurement everywhere'],
  ];
  const options = (list, current) => list.map(([value, label]) => html`<option value="${value}" ${raw(value === current ? 'selected' : '')}>${label}</option>`).join('');
  const retentionForm = (site, error) => html`
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(`/sites/${site.id}/retention`)}" class="card">
<label for="months">Keep events for (months)</label><input id="months" name="months" type="number" min="1" max="120" step="1" required value="${site.retention}">
<p class="muted">Older events are deleted automatically, about once a day. Your privacy policy should state the same period.</p>
<button>Save</button></form>`;

  const consentForm = (site, error) => {
    const c = consentSettings(site);
    const languages = bannerLanguages(c).map(l => [l, l]);
    return html`${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(`/sites/${site.id}/consent`)}" class="card">
<label for="mode">When to ask for consent</label><select id="mode" name="mode">${raw(options(MODES, c.mode))}</select>
<label for="regions">Regions that require consent</label>
<textarea id="regions" name="regions" rows="3">${c.regions.join(' ')}</textarea>
<p class="note">Country codes (ISO 3166-1), used by the first option. Default: the EU and EEA, the United Kingdom and Switzerland. Visitors from an unknown country are asked too. The country comes from the visitor's IP address, which is approximate (VPNs, travelers); if the site's company is established in the EU, asking everyone is the safer choice.</p>
<label for="onRefusal">When a visitor refuses</label><select id="onRefusal" name="onRefusal">${raw(options([['count', 'Count their visits without any identifier'], ['drop', 'Don\'t measure them (only the refusal is recorded)']], c.onRefusal))}</select>
<label><input type="checkbox" name="banner" value="1" style="width:auto" ${raw(c.banner ? 'checked' : '')}> Use Tinybeam's banner</label>
<p class="note">Without it, the site's own consent banner calls <code>tinybeam.consent(true | false)</code>. Changing this changes the snippet above.</p>
<label><input type="checkbox" name="ads" value="1" style="width:auto" ${raw(c.ads ? 'checked' : '')}> Also ask about advertising</label>
<p class="note">Only when the site sends data to advertising platforms. Without it, the banner only asks about the analytics cookie.</p>
<label for="bannerLanguage">Banner language</label><select id="bannerLanguage" name="bannerLanguage">${raw(options([['auto', 'Follow the page (or the visitor\'s browser)'], ...languages], c.bannerLanguage || 'auto'))}</select>
<label for="defaultLanguage">Default language</label><select id="defaultLanguage" name="defaultLanguage">${raw(options(languages, c.defaultLanguage || 'en'))}</select>
<label for="privacy">Privacy policy links</label>
<textarea id="privacy" name="privacy" rows="3" placeholder="en https://example.com/privacy">${Object.entries(c.privacy || {}).map(([l, u]) => `${l} ${u}`).join('\n')}</textarea>
<p class="note">One per line: language code and address.</p>
<label for="position">Banner position</label><select id="position" name="position">${raw(options([['bottom', 'Bottom, centered'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], c.position || 'bottom'))}</select>
<label for="color">Button color</label><input id="color" name="color" type="color" value="${c.color || '#2457d6'}" style="display:block;width:80px;height:38px">
<button>Save consent settings</button></form>
<p><a href="${url(`/sites/${site.id}/banner`)}">Edit the banner's texts and languages</a></p>`;
  };
  // Consent settings from the form; returns [settings, error].
  const parseConsent = fields => {
    const regions = String(fields.regions || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    const bad = regions.find(r => !/^[A-Z]{2}$/.test(r));
    if (bad) return [null, `"${bad}" is not a two-letter country code`];
    const privacy = {};
    for (const line of String(fields.privacy || '').split('\n').map(l => l.trim()).filter(Boolean)) {
      const [lang, link] = line.split(/\s+/);
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang || '') || !/^https?:\/\/\S+$/.test(link || '')) return [null, `"${line}" should be a language code and an address, like "en https://example.com/privacy"`];
      privacy[lang] = link;
    }
    const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
    return [{
      mode: pick(fields.mode, MODES.map(m => m[0]), 'region'),
      regions: regions.length ? [...new Set(regions)] : CONSENT_REGIONS,
      onRefusal: pick(fields.onRefusal, ['count', 'drop'], 'count'),
      banner: fields.banner === '1',
      ads: fields.ads === '1',
      bannerLanguage: /^(auto|[a-z]{2,3}(-[a-z0-9]{2,8})?)$/.test(fields.bannerLanguage || '') ? fields.bannerLanguage : 'auto',
      defaultLanguage: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(fields.defaultLanguage || '') ? fields.defaultLanguage : 'en',
      privacy,
      position: pick(fields.position, ['bottom', 'bottom-left', 'bottom-right'], 'bottom'),
      color: /^#[0-9a-fA-F]{6}$/.test(fields.color || '') ? fields.color : '#2457d6',
    }, null];
  };

  // The banner's texts in one language: the owner's own over the built-in translation, with a preview.
  const bannerPage = (site, lang) => {
    const c = consentSettings(site);
    const own = (c.texts || {})[lang] || {};
    const builtIn = { ...BANNER_TEXTS.en, ...(BANNER_TEXTS[lang] || BANNER_TEXTS[lang.split('-')[0]] || {}) };
    const t = bannerTexts(c, lang);
    const labels = { title: 'Title', body: 'Text', bodyAds: 'Text when asking about advertising', accept: 'Accept button', reject: 'Reject button', customize: 'Choose button', save: 'Save button', analytics: 'Returning-visitor option', ads: 'Advertising option', privacy: 'Privacy policy link' };
    const base = `/sites/${site.id}/banner`;
    return html`${raw(siteHeader(site, 'settings'))}
<h2>Banner texts</h2>
<p class="ranges">${raw(bannerLanguages(c).map(l => html`<a class="${l === lang ? 'on' : ''}" href="${url(base)}?lang=${l}">${l}</a>`).join(''))}</p>
<form method="get" action="${url(base)}" class="card" style="display:flex;gap:8px;align-items:flex-end"><div style="flex:1"><label for="lang">Add a language</label><input id="lang" name="lang" placeholder="ja" pattern="[a-z]{2,3}(-[a-z0-9]{2,8})?" required></div><button>Add</button></form>
<form method="post" action="${url(base)}" class="card"><input type="hidden" name="lang" value="${lang}">
${raw(TEXT_KEYS.map(key => key.startsWith('body')
    ? html`<label for="t-${key}">${labels[key]}</label><textarea id="t-${key}" name="${key}" rows="4" maxlength="600" placeholder="${builtIn[key]}">${own[key] || ''}</textarea>`
    : html`<label for="t-${key}">${labels[key]}</label><input id="t-${key}" name="${key}" maxlength="120" placeholder="${builtIn[key]}" value="${own[key] || ''}">`).join(''))}
<p class="note">Empty fields use the ${BANNER_TEXTS[lang] || BANNER_TEXTS[lang.split('-')[0]] ? 'built-in translation' : 'English text'} shown in grey. Keep "Reject" as easy to find as "Accept", and keep the sentence saying visits are counted anonymously either way.</p>
<button>Save ${lang} texts</button></form>
<h2>Preview</h2>
<div class="card" lang="${lang}" style="max-width:520px"><strong>${t.title}</strong><p style="margin:4px 0 12px">${t.body} <a href="#">${t.privacy}</a></p>
<div style="display:flex;gap:8px;flex-wrap:wrap"><span class="button" style="margin:0;background:${c.color || '#2457d6'}">${t.reject}</span><span class="button" style="margin:0;background:transparent;color:${c.color || '#2457d6'};border:1px solid ${c.color || '#2457d6'}">${t.customize}</span><span class="button" style="margin:0;background:${c.color || '#2457d6'}">${t.accept}</span></div></div>`;
  };

  const empty = '<p class="note">Nothing yet.</p>';
  const stat = (value, label, title) => html`<div class="stat" title="${title || ''}"><b>${value}</b><span>${label}</span></div>`;
  const card = (title, body) => `<div class="card"><h3>${title}</h3>${body}</div>`;
  // A list as labelled bars, scaled to the largest value; with `total`, also as a share of it.
  const bars = (list, total) => {
    if (!list.length || list.every(r => !r.value)) return empty;
    const max = total || Math.max(...list.map(r => r.value));
    return html`<table class="bar">${raw(list.map(r => html`<tr><td>${r.key}<div class="fill" style="width:${Math.max(1, Math.round(r.value / max * 100))}%"></div></td><td>${number(r.value)}${raw(total ? ` <span class="note">${Math.round(r.value / total * 100)}%</span>` : '')}</td></tr>`).join(''))}</table>`;
  };
  const partial = truncated => (truncated ? '<p class="note">These numbers cover only the first rows of the period; choose a shorter range for complete results.</p>' : '');
  const siteHeader = (site, tab, rangeKey = '7d') => {
    const base = `/sites/${site.id}`;
    const tabs = [['overview', base, 'Overview'], ['bots', `${base}/bots`, 'Bots & AI'], ['settings', `${base}/settings`, 'Install & settings']];
    return html`<h1>${site.name} ${raw(site.paused ? '<span class="tag">paused</span>' : '')}</h1>
<nav class="tabs">${raw(tabs.map(([key, href, label]) => html`<a class="${key === tab ? 'on' : ''}" href="${url(href)}${key === 'settings' ? '' : `?range=${rangeKey}`}">${label}</a>`).join(''))}</nav>`;
  };

  async function routes(request) {
    const { pathname, origin, searchParams } = new URL(request.url);
    const path = pathname.slice(basePath.length) || '/';
    const post = request.method === 'POST';
    if (post && !sameOrigin(request)) return new Response('Forbidden', { status: 403 });

    // First run: create the owner account. Closed once any user exists. With `setupToken`, only whoever has
    // the setup link (?token=…) can create it, so a fresh public deployment can't be claimed by someone else.
    if (path === '/setup') {
      if (await store.hasUsers()) return redirect('/login');
      const intro = 'Create the owner account for this Tinybeam installation.';
      const fields = post ? await form(request) : {};
      const token = String((post ? fields.token : searchParams.get('token')) || '');
      if (setupToken && token !== setupToken) {
        return page('Set up', '<h1>Set up</h1><p class="muted">Open the setup link of this installation, with its token, to create the owner account.</p>', null, 403);
      }
      if (!post) return page('Set up', authForm('Create account', '/setup', intro, null, '', token));
      const { email = '', password = '' } = fields;
      if (!email.includes('@') || password.length < 12) {
        return page('Set up', authForm('Create account', '/setup', intro, 'Use a valid email and a password of at least 12 characters.', email, token), null, 400);
      }
      const user = await store.createUser(email.trim().toLowerCase(), await hashPassword(password));
      const session = await store.createSession(user.id);
      return redirect('/', { 'Set-Cookie': cookie(session.token, session.maxAge) });
    }

    if (path === '/login') {
      if (!(await store.hasUsers())) return redirect('/setup');
      const intro = 'Sign in to manage your sites.';
      if (!post) return page('Sign in', authForm('Sign in', '/login', intro));
      const fields = await form(request);
      const email = String(fields.email || '').trim().toLowerCase();
      const blocked = failures.get(email);
      if (blocked && blocked.count >= 5 && blocked.until > Date.now()) {
        return page('Sign in', authForm('Sign in', '/login', intro, 'Too many attempts. Try again in a few minutes.', email), null, 429);
      }
      const user = await store.findUserByEmail(email);
      if (!user || !(await verifyPassword(String(fields.password || ''), user.password))) {
        const entry = failures.get(email) || { count: 0 };
        failures.set(email, { count: entry.count + 1, until: Date.now() + 15 * 60_000 });
        return page('Sign in', authForm('Sign in', '/login', intro, 'Wrong email or password.', email), null, 401);
      }
      failures.delete(email);
      const session = await store.createSession(user.id);
      return redirect('/', { 'Set-Cookie': cookie(session.token, session.maxAge) });
    }

    const user = await store.userForSession(tokenFrom(request));
    if (!user) return redirect((await store.hasUsers()) ? '/login' : '/setup');

    if (path === '/logout' && post) {
      await store.deleteSession(tokenFrom(request));
      return redirect('/login', { 'Set-Cookie': cookie('', 0) });
    }

    if (path === '/') {
      const sites = await store.listSites();
      const rows = sites.map(s => html`<tr><td><a href="${url('/sites/' + s.id)}">${s.name}</a> ${raw(s.paused ? '<span class="tag">paused</span>' : '')}</td><td class="muted">${s.origins.join(', ')}</td><td><code>${s.id}</code></td></tr>`).join('');
      return page('Sites', html`<h1>Sites</h1>
${raw(sites.length ? html`<div class="card"><table><tr><th>Name</th><th>Origins</th><th>ID</th></tr>${raw(rows)}</table></div>` : '<p class="muted">No sites yet.</p>')}
<a class="button" href="${url('/sites/new')}">Add a site</a>`, user);
    }

    if (path === '/sites/new') {
      if (!post) return page('Add a site', html`<h1>Add a site</h1>${raw(siteForm('/sites/new', {}))}`, user);
      const fields = await form(request);
      const name = String(fields.name || '').trim().slice(0, 100);
      const [origins, error] = parseOrigins(fields.origins);
      if (!name || error) return page('Add a site', html`<h1>Add a site</h1>${raw(siteForm('/sites/new', { name, origins: String(fields.origins || '').split(/\s+/) }, error || 'Add a name'))}`, user, 400);
      const site = await store.createSite({ name, origins });
      return redirect(`/sites/${site.id}/settings`);
    }

    const match = path.match(/^\/sites\/([a-z0-9]+)(?:\/(settings|delete|bots|install|consent|retention|banner|events\/([\w.:-]+)))?$/);
    if (match) {
      const site = await store.getSite(match[1]);
      if (!site) return page('Not found', '<h1>Site not found</h1>', user, 404);
      const [, , section, eventName] = match;
      const base = `/sites/${site.id}`;

      if (section === 'delete') {
        if (!post) return page('Not found', '<h1>Page not found</h1>', user, 404);
        const fields = await form(request);
        if (fields.confirm !== site.name) return redirect(`${base}/settings`);
        await store.deleteSite(site.id);
        return redirect('/');
      }
      if (section === 'install') {
        if (!post) return redirect(`${base}/settings`);
        const { host = '' } = await form(request);
        await store.updateSettings(site.id, { host: HOSTS.some(h => h.key === host) ? host : null });
        return redirect(`${base}/settings`);
      }
      if (section === 'retention') {
        if (!post) return redirect(`${base}/settings`);
        const months = Number((await form(request)).months);
        if (!Number.isInteger(months) || months < 1 || months > 120) {
          return page(site.name, html`${raw(siteHeader(site, 'settings'))}<h2>Data retention</h2>${raw(retentionForm(site, 'Use a whole number of months between 1 and 120.'))}`, user, 400, {}, true);
        }
        await store.updateSettings(site.id, { retention: months });
        return redirect(`${base}/settings`);
      }
      if (section === 'consent') {
        if (!post) return redirect(`${base}/settings`);
        const [consent, error] = parseConsent(await form(request));
        if (error) return page(site.name, html`${raw(siteHeader(site, 'settings'))}<h2>Consent</h2>${raw(consentForm(site, error))}`, user, 400, {}, true);
        await store.updateSettings(site.id, { consent: { ...site.consent, ...consent } });
        return redirect(`${base}/settings`);
      }
      if (section === 'banner') {
        if (post) {
          const fields = await form(request);
          const lang = String(fields.lang || '');
          if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang)) return redirect(`${base}/banner`);
          const own = {};
          for (const key of TEXT_KEYS) {
            const value = String(fields[key] || '').trim().slice(0, key.startsWith('body') ? 600 : 120);
            if (value) own[key] = value;
          }
          const texts = { ...(site.consent.texts || {}) };
          if (Object.keys(own).length) texts[lang] = own; else delete texts[lang];
          await store.updateSettings(site.id, { consent: { ...site.consent, texts } });
          return redirect(`${base}/banner?lang=${lang}`);
        }
        const asked = searchParams.get('lang') || '';
        const lang = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(asked) ? asked : consentSettings(site).defaultLanguage || 'en';
        return page(`${site.name} · Banner`, bannerPage(site, lang), user, 200, {}, true);
      }
      if (section === 'settings') {
        if (post) {
          const fields = await form(request);
          const name = String(fields.name || '').trim().slice(0, 100);
          const [origins, error] = parseOrigins(fields.origins);
          if (!name || error) return page(site.name, html`<h1>${site.name}</h1>${raw(siteForm(`${base}/settings`, { ...site, name }, error || 'Add a name'))}`, user, 400);
          await store.updateSite(site.id, { name, origins, paused: fields.paused === '1' });
          return redirect(`${base}/settings`);
        }
        const check = site.host ? checkInstall(site.host, await queries.installCheck(site.id, now() - 7 * 864e5, now())) : null;
        return page(site.name, html`${raw(siteHeader(site, 'settings'))}
<p class="muted">Site ID <code>${site.id}</code></p>
${raw(install(site, site.host, origin, check))}
<h2>Consent</h2>${raw(consentForm(site))}
<h2>Data retention</h2>${raw(retentionForm(site))}
<h2>Settings</h2>${raw(siteForm(`${base}/settings`, site))}
<h2>Delete</h2>
<form method="post" action="${url(`${base}/delete`)}" class="card">
<p>Deletes the site and <strong>every event recorded for it</strong>. This can't be undone. Type the site's name to confirm.</p>
<input name="confirm" required aria-label="Site name" placeholder="${site.name}"><button class="danger">Delete site and data</button></form>`, user, 200, {}, true);
      }
      if (post) return new Response('Method Not Allowed', { status: 405 });

      const rangeKey = RANGES[searchParams.get('range')] ? searchParams.get('range') : '7d';
      const to = now();
      const from = to - RANGES[rangeKey];
      // Report filters: consent state (docs/spec.md, section 5).
      const consentFilter = CONSENT_STATES.includes(searchParams.get('consent')) ? searchParams.get('consent') : null;
      const filter = { consent: consentFilter };
      const query = (changes = {}) => `?${new URLSearchParams(Object.entries({ range: rangeKey, consent: consentFilter, ...changes }).filter(([, v]) => v))}`;
      const ranges = html`<p class="ranges">${raw(Object.keys(RANGES).map(k => html`<a class="${k === rangeKey ? 'on' : ''}" href="${url(path)}${query({ range: k })}">${k}</a>`).join(''))}</p>`;
      const consentBar = html`<p class="ranges">Consent: ${raw([[null, 'all'], ...CONSENT_STATES.map(s => [s, CONSENT_LABELS[s]])].map(([value, label]) => html`<a class="${value === consentFilter ? 'on' : ''}" href="${url(path)}${query({ consent: value })}">${label}</a>`).join(''))}</p>`;

      if (section === 'bots') {
        const data = await queries.bots(site.id, from, to);
        const botList = data.bots.length
          ? html`<table class="bar">${raw(data.bots.map(b => html`<tr><td>${b.key} <span class="tag">${b.category}</span><br><span class="note">last seen ${new Date(b.last).toISOString().slice(0, 16).replace('T', ' ')} UTC</span></td><td>${number(b.value)}</td></tr>`).join(''))}</table>`
          : empty;
        return page(`${site.name} · Bots & AI`, html`${raw(siteHeader(site, 'bots', rangeKey))}${raw(ranges)}
<div class="stats">${raw(stat(number(data.total), 'bot requests'))}${raw(stat(number(data.verified.verified || 0), 'from verified bots'))}${raw(stat(number(data.aiReferrals.reduce((a, r) => a + r.value, 0)), 'visits referred by AI assistants'))}</div>
<div class="grid" style="margin-top:12px">
${raw(card('By category', bars(data.categories)))}
${raw(card('Bots', botList))}
${raw(card('Most requested paths', bars(data.paths)))}
${raw(card('Special files', bars(data.specialFiles)))}
${raw(card('Visits referred by AI assistants', bars(data.aiReferrals)))}
</div>
<p class="note">Bots are seen when a collector is in front of the site (every request) or when they run the script. Verified means the platform confirmed the bot's identity; the others are identified by user agent only. Special files are robots.txt, sitemaps, llms.txt and Markdown versions of pages. "Other" are page views whose user agent looks like a browser but that never ran the script nor loaded the noscript pixel: almost always bots, so they are not counted as visitors.</p>${raw(partial(data.truncated))}`, user, 200, {}, true);
      }

      if (eventName) {
        const data = await queries.event(site.id, eventName, from, to, filter);
        const props = data.properties.map(p => card(html`${p.key} <span class="tag">${p.scope}</span>`, bars(p.values, data.total))).join('');
        return page(`${site.name} · ${eventName}`, html`${raw(siteHeader(site, 'overview', rangeKey))}
<h2>Event: ${eventName}</h2>${raw(ranges)}${raw(consentBar)}
<div class="stats">${raw(stat(number(data.total), 'events'))}</div>
<p class="note">Each attribute shows the scope it comes from. Page, session and user attributes apply to every event of that page view, session or user, including events sent before they were set.</p>
<div class="grid">${raw(props || card('Attributes', empty))}</div>${raw(partial(data.truncated))}`, user, 200, {}, true);
      }

      const [data, attrs] = await Promise.all([queries.overview(site.id, from, to, filter), queries.attributeSummary(site.id, from, to)]);
      const t = data.totals;
      const eventList = data.events.length
        ? html`<table class="bar">${raw(data.events.map(e => html`<tr><td><a href="${url(`${base}/events/${e.key}`)}${query()}">${e.key}</a></td><td>${number(e.value)}</td></tr>`).join(''))}</table>`
        : empty;
      const consentTotal = data.consent.reduce((a, r) => a + r.value, 0);
      const consentRows = list => list.map(r => ({ key: CONSENT_LABELS[r.key] || r.key, value: r.value }));
      const consentCard = card('Consent', bars(consentRows(data.consent), consentTotal)
        + html`<p class="note">Page views by consent state. Sessions:</p>` + bars(consentRows(data.consentSessions))
        + html`<p class="note">Refusals have no sessions: they are counted without any identifier. Visitors who accept are recognized across days; the others only within a day, so a report on accepted visitors only covers ${consentTotal ? Math.round(((data.consent.find(r => r.key === 'granted') || { value: 0 }).value / consentTotal) * 100) : 0}% of page views, and they may not behave like everyone else.</p>`);
      const scopeCards = ['page', 'session', 'user'].map(scope => card(`${scope[0].toUpperCase()}${scope.slice(1)} attributes`,
        attrs[scope].length ? attrs[scope].map(a => html`<p style="margin:8px 0 2px"><strong>${a.key}</strong></p>${raw(bars(a.values))}`).join('') : empty)).join('');
      const jsLabels = { on: 'Script ran', off: 'Disabled (noscript pixel)', unknown: 'No script data (server only)' };
      const jsTotal = data.js.reduce((a, r) => a + r.value, 0);
      return page(site.name, html`${raw(siteHeader(site, 'overview', rangeKey))}${raw(ranges)}${raw(consentBar)}
<div class="stats">
${raw(stat(number(t.visitors), 'visitors', `${number(t.stableVisitors)} recognized across days (a stable ID, with consent or where none is needed); the rest are daily unique visitors, summed, since without a stable ID a returning visitor counts once per day.`))}
${raw(stat(number(t.sessions), 'sessions'))}
${raw(stat(number(t.pageViews), 'page views'))}
${raw(stat(duration(t.avgVisibleMs), 'visible time per page view', `Over ${number(t.timedPageViews)} page views with engagement data.`))}
${raw(stat(number(t.bots), 'bot requests', `Not included in any other number here. ${t.unconfirmed ? `Includes ${number(t.unconfirmed)} page views that never ran the script, counted as other bots.` : ''}`))}
</div>
<div class="grid" style="margin-top:12px">
${raw(card('Pages', bars(data.pages)))}
${raw(card('Sources (sessions)', bars(data.referrerTypes)))}
${raw(card('Referrers (sessions)', bars(data.referrers)))}
${raw(card('Campaigns (sessions)', bars(data.campaigns)))}
${raw(card('Events', eventList))}
${raw(card('Scroll depth', bars(data.scrollDepth, data.scrolledPageViews) + html`<p class="note">Deepest point reached, over ${number(data.scrolledPageViews)} page views with engagement data.</p>`))}
${raw(card('Countries', bars(data.countries)))}
${raw(card('Devices', bars(data.devices)))}
${raw(card('Browsers', bars(data.browsers)))}
${raw(card('Operating systems', bars(data.os)))}
${raw(card('JavaScript', bars(data.js.map(r => ({ key: jsLabels[r.key] || r.key, value: r.value })), jsTotal)))}
${raw(consentCard)}
</div>
<h2>Attributes</h2>
<p class="note">Current values: how many page views, sessions or users have each one.</p>
<div class="grid">${raw(scopeCards)}</div>${raw(partial(data.truncated || attrs.truncated))}`, user, 200, {}, true);
    }

    return page('Not found', '<h1>Page not found</h1>', user, 404);
  }

  return {
    handle: request => routes(request),
    queries,
    basePath,
  };
}
