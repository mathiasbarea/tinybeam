// The portal: server-rendered pages for setting up the owner account, signing in and managing sites. Like
// the collector, it is a web-standard handler (Request in, Response out) and needs no JavaScript in the
// browser. Pages live under `basePath`; the owner mounts it on whatever URL they want.
import { hashPassword, verifyPassword } from './auth.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? (values[i] && values[i].raw !== undefined ? values[i].raw : escape(values[i])) : ''), '');
const raw = text => ({ raw: text });

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--line:#ddd;--card:#fff;--accent:#2457d6;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--card:#1a1a1a;--accent:#7aa2ff;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
header a{color:inherit;text-decoration:none;font-weight:600}main{max-width:760px;margin:0 auto;padding:24px 20px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:28px 0 8px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
label{display:block;margin:12px 0 4px;font-weight:600}input,textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit;font:inherit}
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

const RANGES = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };
const number = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const duration = ms => (ms == null ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function createPortal({ store, queries, basePath = '/portal', collectorPath = '/tb', secureCookies = true, now = Date.now }) {
  const COOKIE = 'tb_session';
  const url = path => basePath + path;
  const failures = new Map(); // email -> { count, until }: slows down password guessing

  const page = (title, body, user, status = 200, headers = {}, wide = false) => new Response(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tinybeam</title><style>${raw(CSS)}</style></head><body>
<header><a href="${url('/')}">Tinybeam</a>${raw(user ? html`<form method="post" action="${url('/logout')}"><span class="muted">${user.email}</span> &nbsp;<button class="link">Sign out</button></form>` : '')}</header>
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

  const authForm = (title, action, intro, error, email = '') => html`
<h1>${title}</h1><p class="muted">${intro}</p>
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(action)}" class="card">
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

  const snippet = (site, origin) => {
    const firstParty = `<script src="${collectorPath}/tinybeam.js" data-site="${site.id}" data-pv defer></script>\n<noscript><img src="${collectorPath}/n?s=${site.id}" alt="" width="1" height="1"></noscript>`;
    const direct = `<script src="${origin}${collectorPath}/tinybeam.js" data-site="${site.id}" data-endpoint="${origin}${collectorPath}/e" data-pv defer></script>\n<noscript><img src="${origin}${collectorPath}/n?s=${site.id}" alt="" width="1" height="1"></noscript>`;
    return html`
<h2>Install</h2>
<p>Paste this before <code>&lt;/head&gt;</code> on every page.</p>
<p><strong>From your site's own domain</strong> (recommended: first-party, rarely blocked). Route <code>${collectorPath}/</code> on your site to this collector with your proxy or host's rewrites.</p>
<pre>${firstParty}</pre>
<p><strong>Directly to this collector</strong>, if you can't route a path on your site.</p>
<pre>${direct}</pre>`;
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

    // First run: create the owner account. Closed once any user exists.
    if (path === '/setup') {
      if (await store.hasUsers()) return redirect('/login');
      const intro = 'Create the owner account for this Tinybeam installation.';
      if (!post) return page('Set up', authForm('Create account', '/setup', intro));
      const { email = '', password = '' } = await form(request);
      if (!email.includes('@') || password.length < 12) {
        return page('Set up', authForm('Create account', '/setup', intro, 'Use a valid email and a password of at least 12 characters.', email), null, 400);
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

    const match = path.match(/^\/sites\/([a-z0-9]+)(?:\/(settings|delete|bots|events\/([\w.:-]+)))?$/);
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
      if (section === 'settings') {
        if (post) {
          const fields = await form(request);
          const name = String(fields.name || '').trim().slice(0, 100);
          const [origins, error] = parseOrigins(fields.origins);
          if (!name || error) return page(site.name, html`<h1>${site.name}</h1>${raw(siteForm(`${base}/settings`, { ...site, name }, error || 'Add a name'))}`, user, 400);
          await store.updateSite(site.id, { name, origins, paused: fields.paused === '1' });
          return redirect(`${base}/settings`);
        }
        return page(site.name, html`${raw(siteHeader(site, 'settings'))}
<p class="muted">Site ID <code>${site.id}</code></p>
${raw(snippet(site, origin))}
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
      const ranges = html`<p class="ranges">${raw(Object.keys(RANGES).map(k => html`<a class="${k === rangeKey ? 'on' : ''}" href="${url(path)}?range=${k}">${k}</a>`).join(''))}</p>`;

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
<p class="note">Bots are seen when a collector is in front of the site (every request) or when they run the script. Verified means the platform confirmed the bot's identity; the others are identified by user agent only. Special files are robots.txt, sitemaps, llms.txt and Markdown versions of pages.</p>`, user, 200, {}, true);
      }

      if (eventName) {
        const data = await queries.event(site.id, eventName, from, to);
        const props = data.properties.map(p => card(html`${p.key} <span class="tag">${p.scope}</span>`, bars(p.values, data.total))).join('');
        return page(`${site.name} · ${eventName}`, html`${raw(siteHeader(site, 'overview', rangeKey))}
<h2>Event: ${eventName}</h2>${raw(ranges)}
<div class="stats">${raw(stat(number(data.total), 'events'))}</div>
<p class="note">Each attribute shows the scope it comes from. Page, session and user attributes apply to every event of that page view, session or user, including events sent before they were set.</p>
<div class="grid">${raw(props || card('Attributes', empty))}</div>${raw(partial(data.truncated))}`, user, 200, {}, true);
      }

      const [data, attrs] = await Promise.all([queries.overview(site.id, from, to), queries.attributeSummary(site.id, from, to)]);
      const t = data.totals;
      const eventList = data.events.length
        ? html`<table class="bar">${raw(data.events.map(e => html`<tr><td><a href="${url(`${base}/events/${e.key}`)}?range=${rangeKey}">${e.key}</a></td><td>${number(e.value)}</td></tr>`).join(''))}</table>`
        : empty;
      const scopeCards = ['page', 'session', 'user'].map(scope => card(`${scope[0].toUpperCase()}${scope.slice(1)} attributes`,
        attrs[scope].length ? attrs[scope].map(a => html`<p style="margin:8px 0 2px"><strong>${a.key}</strong></p>${raw(bars(a.values))}`).join('') : empty)).join('');
      const jsLabels = { on: 'Script ran', off: 'Disabled (noscript pixel)', unknown: 'No script data (server only)' };
      const jsTotal = data.js.reduce((a, r) => a + r.value, 0);
      return page(site.name, html`${raw(siteHeader(site, 'overview', rangeKey))}${raw(ranges)}
<div class="stats">
${raw(stat(number(t.visitors), 'visitors', 'Daily unique visitors, summed: without consent the anonymous ID changes every day.'))}
${raw(stat(number(t.sessions), 'sessions'))}
${raw(stat(number(t.pageViews), 'page views'))}
${raw(stat(duration(t.avgVisibleMs), 'visible time per page view', `Over ${number(t.timedPageViews)} page views with engagement data.`))}
${raw(stat(number(t.bots), 'bot requests', 'Not included in any other number here.'))}
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
