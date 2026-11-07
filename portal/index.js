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

export function createPortal({ store, basePath = '/portal', collectorPath = '/tb', secureCookies = true }) {
  const COOKIE = 'tb_session';
  const url = path => basePath + path;
  const failures = new Map(); // email -> { count, until }: slows down password guessing

  const page = (title, body, user, status = 200, headers = {}) => new Response(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tinybeam</title><style>${raw(CSS)}</style></head><body>
<header><a href="${url('/')}">Tinybeam</a>${raw(user ? html`<form method="post" action="${url('/logout')}"><span class="muted">${user.email}</span> &nbsp;<button class="link">Sign out</button></form>` : '')}</header>
<main>${raw(body)}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...headers } });

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

  async function routes(request) {
    const { pathname, origin } = new URL(request.url);
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
      return redirect('/sites/' + site.id);
    }

    const match = path.match(/^\/sites\/([a-z0-9]+)(\/delete)?$/);
    if (match) {
      const site = await store.getSite(match[1]);
      if (!site) return page('Not found', '<h1>Site not found</h1>', user, 404);
      if (match[2]) {
        if (!post) return page('Delete site', '<h1>Not found</h1>', user, 404);
        const fields = await form(request);
        if (fields.confirm !== site.name) return redirect('/sites/' + site.id);
        await store.deleteSite(site.id);
        return redirect('/');
      }
      if (post) {
        const fields = await form(request);
        const name = String(fields.name || '').trim().slice(0, 100);
        const [origins, error] = parseOrigins(fields.origins);
        if (!name || error) return page(site.name, html`<h1>${site.name}</h1>${raw(siteForm('/sites/' + site.id, { ...site, name }, error || 'Add a name'))}`, user, 400);
        await store.updateSite(site.id, { name, origins, paused: fields.paused === '1' });
        return redirect('/sites/' + site.id);
      }
      return page(site.name, html`<h1>${site.name} ${raw(site.paused ? '<span class="tag">paused</span>' : '')}</h1>
<p class="muted">Site ID <code>${site.id}</code></p>
${raw(snippet(site, origin))}
<h2>Settings</h2>${raw(siteForm('/sites/' + site.id, site))}
<h2>Delete</h2>
<form method="post" action="${url('/sites/' + site.id + '/delete')}" class="card">
<p>Deletes the site and <strong>every event recorded for it</strong>. This can't be undone. Type the site's name to confirm.</p>
<input name="confirm" required aria-label="Site name" placeholder="${site.name}"><button class="danger">Delete site and data</button></form>`, user);
    }

    return page('Not found', '<h1>Page not found</h1>', user, 404);
  }

  return {
    handle: request => routes(request),
    basePath,
  };
}
