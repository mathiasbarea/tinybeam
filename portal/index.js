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

// One stylesheet for every page, inlined (about 6 KB): warm neutrals, the brand's amber for data and
// focus, ink for actions, and a dark theme that follows the system.
const CSS = `
:root{color-scheme:light dark;--bg:#f7f6f2;--surface:#fff;--ink:#16181d;--ink-2:#454a53;--muted:#787d86;--line:#e8e6e0;--line-2:#d6d3cb;--beam:#f5a524;--beam-ink:#9a5800;--beam-soft:rgba(245,165,36,.15);--beam-mid:rgba(245,165,36,.32);--up:#18794e;--down:#b42318;--danger:#b42318;--focus:rgba(245,165,36,.5);--shadow:0 1px 2px rgba(22,24,29,.04);--pop:0 12px 32px rgba(22,24,29,.14)}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161920;--ink:#eceae4;--ink-2:#c3c1bb;--muted:#8b919a;--line:#242830;--line-2:#323741;--beam-ink:#f7b955;--beam-soft:rgba(245,165,36,.13);--beam-mid:rgba(245,165,36,.3);--up:#4cc38a;--down:#ff8a80;--danger:#ff8a80;--shadow:none;--pop:0 12px 32px rgba(0,0,0,.5)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
a{color:var(--beam-ink);text-underline-offset:2px}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line)}
.top .in{max-width:1120px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:14px}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-weight:650;letter-spacing:-.01em;text-decoration:none}
.top form{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:13px;color:var(--muted)}
main{max-width:1120px;margin:0 auto;padding:28px 20px 72px}main.narrow{max-width:420px;padding-top:8vh}.col{max-width:760px}
h1{font-size:24px;line-height:1.25;letter-spacing:-.02em;margin:0}
h2{font-size:12px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:36px 0 12px}
h3{font-size:14px;font-weight:600;margin:0}p{margin:8px 0}
.muted{color:var(--muted)}.note{font-size:13px;color:var(--muted);margin:10px 0 0}
code,pre{font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:10px 0 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:var(--shadow);min-width:0}
.stack>*+*{margin-top:12px}
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px}
.sub{color:var(--muted);font-size:14px;margin-top:3px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 18px;overflow-x:auto}
.tabs a{padding:9px 12px;color:var(--muted);text-decoration:none;font-weight:550;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--ink)}.tabs a.on{color:var(--ink);border-color:var(--beam)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}
.seg{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:3px}
.seg a{padding:4px 12px;border-radius:6px;color:var(--ink-2);text-decoration:none;font-size:13px;font-weight:550}
.seg a:hover{color:var(--ink)}.seg a.on{background:var(--ink);color:var(--surface)}
.menu{position:relative}.menu summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:6px 12px;font-size:13px;font-weight:550;color:var(--ink-2)}
.menu summary::-webkit-details-marker{display:none}.menu summary:after{content:"";width:6px;height:6px;border:solid var(--muted);border-width:0 1.5px 1.5px 0;transform:rotate(45deg) translateY(-2px)}
.menu .pop{position:absolute;z-index:4;top:calc(100% + 6px);left:0;min-width:230px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:var(--pop)}
.menu .pop a{display:block;padding:7px 10px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:13px}.menu .pop a:hover{background:var(--bg)}.menu .pop a.on{background:var(--beam-soft);font-weight:600}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:13px;background:var(--beam-soft);color:var(--ink);border-radius:999px;padding:4px 6px 4px 12px}.chip a{color:var(--muted);text-decoration:none;padding:0 6px}.chip a:hover{color:var(--ink)}
.hero{padding:0;overflow:hidden}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:0 -1px -1px 0}
.kpi{display:block;padding:16px 20px;box-shadow:inset -1px -1px 0 var(--line);color:inherit;text-decoration:none}
a.kpi:hover{background:var(--bg)}
.kpi .l{font-size:13px;color:var(--muted)}.kpi .v{font-size:28px;font-weight:650;letter-spacing:-.025em;line-height:1.2;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .d{font-size:12px;margin-top:3px;color:var(--muted);font-variant-numeric:tabular-nums}.kpi .up{color:var(--up)}.kpi .down{color:var(--down)}
.plotwrap{padding:16px 20px 18px}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.chart{display:grid;grid-template-columns:auto 1fr;gap:10px;margin-top:12px}
.yax{display:flex;flex-direction:column;justify-content:space-between;height:180px;font-size:11px;line-height:1;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.plot svg{display:block;width:100%;height:180px;border-bottom:1px solid var(--line-2)}
.plot .g{stroke:var(--line)}.plot .pv{fill:var(--beam-mid)}.plot .v{fill:var(--beam)}.plot .hit{fill:transparent}.plot g:hover .hit{fill:var(--beam-soft)}
.xax{display:grid;font-size:11px;color:var(--muted);margin-top:6px}.xax span{text-align:center;white-space:nowrap}@media (max-width:560px){.xax .minor{visibility:hidden}}
details.more summary{cursor:pointer;font-size:13px;color:var(--muted);padding:8px 0 0;list-style:none}details.more summary::-webkit-details-marker{display:none}details.more summary:hover{color:var(--ink)}details.more[open] summary{display:none}details.more .rows{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:14px}
.ph{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.ph .unit{font-size:12px;color:var(--muted)}
.rows{list-style:none;margin:10px -10px 0;padding:0}
.rows li{position:relative;z-index:0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 10px;font-size:14px}
.rows .b{position:absolute;z-index:-1;inset:2px auto 2px 0;background:var(--beam-soft);border-radius:6px}
.rows .k{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rows .k a{color:var(--ink);text-decoration:none}.rows .k a:hover{text-decoration:underline}
.rows .n{flex:none;font-variant-numeric:tabular-nums;color:var(--ink-2)}.rows .p{display:inline-block;min-width:38px;text-align:right;font-size:12px;color:var(--muted)}
.rows .s{display:block;font-size:12px;color:var(--muted)}
.empty{font-size:13px;color:var(--muted);padding:14px 0 4px;margin:0}
.tag{display:inline-block;font-size:11px;line-height:1.7;padding:0 8px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted);font-weight:550;vertical-align:1px}
details.how{margin-top:14px;font-size:13px;color:var(--muted)}details.how summary{cursor:pointer;color:var(--ink-2)}
.banner{background:var(--beam-soft);border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px}
label{display:block;margin:14px 0 6px;font-weight:550;font-size:14px}
input,textarea,select{width:100%;padding:9px 11px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface);color:inherit;font:inherit}
input[type=checkbox]{width:auto;accent-color:var(--beam);margin-right:6px}
input:focus,textarea:focus,select:focus,button:focus-visible,a:focus-visible,summary:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus);border-color:var(--beam)}
button,.button{display:inline-flex;align-items:center;gap:6px;margin-top:16px;padding:9px 16px;border:0;border-radius:8px;background:var(--ink);color:var(--surface);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button:hover,.button:hover{opacity:.88}
button.link{background:none;color:var(--muted);padding:0;margin:0;font-weight:500;font-size:13px}button.link:hover{color:var(--ink)}
button.danger{background:var(--danger);color:#fff}
.error{color:var(--danger);background:var(--beam-soft);border-left:3px solid var(--danger);border-radius:6px;padding:10px 12px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:600}
.jump{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}.jump a{font-size:13px;color:var(--ink-2);text-decoration:none;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:4px 12px}.jump a:hover{color:var(--ink);border-color:var(--line-2)}
.danger-zone{border-color:var(--danger)}
.sites{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px}
.site{display:block;color:inherit;text-decoration:none}.site:hover{border-color:var(--line-2)}.site b{font-size:16px}.site .go{color:var(--beam-ink);font-size:13px;margin-top:10px}
.auth{text-align:center;margin-bottom:22px}.auth svg{width:72px;height:72px}.auth h1{margin-top:10px}
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
const RANGE_NAMES = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
const SOURCE_LABELS = { direct: 'Direct', internal: 'Within the site', search: 'Search engines', referral: 'Other sites', social: 'Social networks', ai_assistant: 'AI assistants', email: 'Email' };
const BOT_LABELS = {
  search: 'Search engines', ai_training: 'AI training crawlers', ai_search: 'AI search', ai_user_fetch: 'AI assistants reading for a user',
  seo_tool: 'SEO tools', http_client: 'HTTP clients', automation: 'Automation', monitoring: 'Monitoring', social_preview: 'Link previews',
  unidentified: 'Unidentified bots', other: 'Other (never ran the script)',
};
const number = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const duration = ms => (ms == null ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const capital = text => (text ? String(text)[0].toUpperCase() + String(text).slice(1) : text);
const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return code => { try { return code === 'T1' ? 'Tor network' : /^[A-Z]{2}$/.test(code) ? names.of(code) : code; } catch { return code; } };
  } catch { return code => code; }
})();
const ago = (ms, now) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

export function createPortal({ store, queries, basePath = '/portal', collectorPath = '/tb', secureCookies = true, setupToken = null, now = Date.now }) {
  const COOKIE = 'tb_session';
  const url = path => basePath + path;
  const failures = new Map(); // email -> { count, until }: slows down password guessing

  // layout: true or 'wide' for dashboards, 'narrow' for sign-in pages, anything else for the default.
  const page = (title, body, user, status = 200, headers = {}, layout = false) => new Response(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tinybeam</title><link rel="icon" href="${FAVICON}" type="image/svg+xml"><style>${raw(CSS)}</style></head><body>
${raw(layout === 'narrow' ? '' : html`<header class="top"><div class="in"><a class="brand" href="${url('/')}">${raw(MARK)}Tinybeam</a>${raw(user ? html`<form method="post" action="${url('/logout')}"><span>${user.email}</span><button class="link">Sign out</button></form>` : '')}</div></header>`)}
<main class="${layout === 'narrow' ? 'narrow' : ''}">${raw(body)}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...headers } });

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
<div class="auth">${raw(MARK.replace('width="22" height="22"', 'width="44" height="44"'))}<h1>${title}</h1><p class="muted">${intro}</p></div>
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(action)}" class="card">
${raw(token ? html`<input type="hidden" name="token" value="${token}">` : '')}
<label for="email" style="margin-top:0">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${email}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${action === '/setup' ? 'new-password' : 'current-password'}" minlength="${action === '/setup' ? 12 : 1}" required>
<button style="width:100%;justify-content:center">${title}</button></form>`;

  const siteForm = (action, site, error) => html`
${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(action)}" class="card">
<label for="name" style="margin-top:0">Name</label><input id="name" name="name" required maxlength="100" value="${site.name || ''}">
<label for="origins">Origins</label>
<textarea id="origins" name="origins" rows="3" required placeholder="https://example.com">${(site.origins || []).join('\n')}</textarea>
<p class="note">Where the site's pages are served from, one per line. Events from other origins are rejected.</p>
${raw(site.id ? html`<label><input type="checkbox" name="paused" value="1" ${raw(site.paused ? 'checked' : '')}> Paused (stop recording)</label>` : '')}
<button>${site.id ? 'Save' : 'Add site'}</button></form>`;

  // Installation: one question (where the site is hosted), then only the steps that fit, and a check of how
  // recent page views kept the stable ID (portal/install.js).
  const install = (site, hostKey, origin, check) => {
    const base = `/sites/${site.id}`;
    const host = HOSTS.find(h => h.key === hostKey);
    const steps = host ? installSteps(host.key, site, { origin, path: collectorPath, banner: consentSettings(site).banner }) : [];
    return html`
<h2 id="install">Install</h2>
<div class="stack">
<form method="post" action="${url(`${base}/install`)}" class="card">
<label for="host" style="margin-top:0">Where is the site hosted?</label>
<select id="host" name="host">${raw(`<option value="">Choose…</option>` + HOSTS.map(h => html`<option value="${h.key}" ${raw(h.key === hostKey ? 'selected' : '')}>${h.label}</option>`).join(''))}</select>
<button>Show how to install</button></form>
${raw(steps.map((step, i) => html`<div class="card"><h3>${i + 1}. ${step.title}</h3>${raw(step.text ? html`<p>${step.text}</p>` : '')}${raw(step.code ? html`<pre>${step.code}</pre>` : '')}</div>`).join(''))}
</div>
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
<label for="months" style="margin-top:0">Keep events for (months)</label><input id="months" name="months" type="number" min="1" max="120" step="1" required value="${site.retention}">
<p class="note">Older events are deleted automatically, about once a day. Your privacy policy should state the same period.</p>
<button>Save</button></form>`;

  const consentForm = (site, error) => {
    const c = consentSettings(site);
    const languages = bannerLanguages(c).map(l => [l, l]);
    return html`${raw(error ? html`<p class="error">${error}</p>` : '')}
<form method="post" action="${url(`/sites/${site.id}/consent`)}" class="card">
<label for="mode" style="margin-top:0">When to ask for consent</label><select id="mode" name="mode">${raw(options(MODES, c.mode))}</select>
<label for="regions">Regions that require consent</label>
<textarea id="regions" name="regions" rows="3">${c.regions.join(' ')}</textarea>
<p class="note">Country codes (ISO 3166-1), used by the first option. Default: the EU and EEA, the United Kingdom and Switzerland. Visitors from an unknown country are asked too. The country comes from the visitor's IP address, which is approximate (VPNs, travelers); if the site's company is established in the EU, asking everyone is the safer choice.</p>
<label for="onRefusal">When a visitor refuses</label><select id="onRefusal" name="onRefusal">${raw(options([['count', 'Count their visits without any identifier'], ['drop', 'Don\'t measure them (only the refusal is recorded)']], c.onRefusal))}</select>
<label><input type="checkbox" name="banner" value="1" ${raw(c.banner ? 'checked' : '')}> Use Tinybeam's banner</label>
<p class="note">Without it, the site's own consent banner calls <code>tinybeam.consent(true | false)</code>. Changing this changes the snippet above.</p>
<label><input type="checkbox" name="ads" value="1" ${raw(c.ads ? 'checked' : '')}> Also ask about advertising</label>
<p class="note">Only when the site sends data to advertising platforms. Without it, the banner only asks about the analytics cookie.</p>
<label for="bannerLanguage">Banner language</label><select id="bannerLanguage" name="bannerLanguage">${raw(options([['auto', 'Follow the page (or the visitor\'s browser)'], ...languages], c.bannerLanguage || 'auto'))}</select>
<label for="defaultLanguage">Default language</label><select id="defaultLanguage" name="defaultLanguage">${raw(options(languages, c.defaultLanguage || 'en'))}</select>
<label for="privacy">Privacy policy links</label>
<textarea id="privacy" name="privacy" rows="3" placeholder="en https://example.com/privacy">${Object.entries(c.privacy || {}).map(([l, u]) => `${l} ${u}`).join('\n')}</textarea>
<p class="note">One per line: language code and address.</p>
<label for="position">Banner position</label><select id="position" name="position">${raw(options([['bottom', 'Bottom, centered'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], c.position || 'bottom'))}</select>
<label for="color">Button color</label><input id="color" name="color" type="color" value="${c.color || '#2457d6'}" style="display:block;width:80px;height:38px;padding:4px">
<button>Save consent settings</button></form>
<p><a href="${url(`/sites/${site.id}/banner`)}">Edit the banner's texts and languages →</a></p>`;
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
    return html`${raw(siteHeader(site, 'settings'))}<div class="col">
<p><a href="${url(`/sites/${site.id}/settings`)}">← Settings</a></p>
<h2>Banner texts</h2>
<div class="toolbar"><div class="seg">${raw(bannerLanguages(c).map(l => html`<a class="${l === lang ? 'on' : ''}" href="${url(base)}?lang=${l}">${l}</a>`).join(''))}</div></div>
<div class="stack">
<form method="get" action="${url(base)}" class="card" style="display:flex;gap:10px;align-items:flex-end"><div style="flex:1"><label for="lang" style="margin-top:0">Add a language</label><input id="lang" name="lang" placeholder="ja" pattern="[a-z]{2,3}(-[a-z0-9]{2,8})?" required></div><button>Add</button></form>
<form method="post" action="${url(base)}" class="card"><input type="hidden" name="lang" value="${lang}">
${raw(TEXT_KEYS.map(key => key.startsWith('body')
    ? html`<label for="t-${key}">${labels[key]}</label><textarea id="t-${key}" name="${key}" rows="4" maxlength="600" placeholder="${builtIn[key]}">${own[key] || ''}</textarea>`
    : html`<label for="t-${key}">${labels[key]}</label><input id="t-${key}" name="${key}" maxlength="120" placeholder="${builtIn[key]}" value="${own[key] || ''}">`).join(''))}
<p class="note">Empty fields use the ${BANNER_TEXTS[lang] || BANNER_TEXTS[lang.split('-')[0]] ? 'built-in translation' : 'English text'} shown in grey. Keep "Reject" as easy to find as "Accept", and keep the sentence saying visits are counted anonymously either way.</p>
<button>Save ${lang} texts</button></form>
</div>
<h2>Preview</h2>
<div class="card" lang="${lang}" style="max-width:520px"><strong>${t.title}</strong><p style="margin:4px 0 12px">${t.body} <a href="#">${t.privacy}</a></p>
<div style="display:flex;gap:8px;flex-wrap:wrap"><span class="button" style="margin:0;background:${c.color || '#2457d6'};color:#fff">${t.reject}</span><span class="button" style="margin:0;background:transparent;color:${c.color || '#2457d6'};border:1px solid ${c.color || '#2457d6'}">${t.customize}</span><span class="button" style="margin:0;background:${c.color || '#2457d6'};color:#fff">${t.accept}</span></div></div></div>`;
  };

  const empty = '<p class="empty">Nothing in this period yet.</p>';
  const panel = (title, body, unit = '') => `<section class="card"><div class="ph"><h3>${title}</h3>${unit ? html`<span class="unit">${unit}</span>` : ''}</div>${body}</section>`;
  // A ranked list: each row's bar is its share of the largest value; with `total`, the share of it shows
  // as a percentage. `label` names a key, `href` links it, `sub` adds a second line.
  const rows = (list, { total = 0, label = key => key, href = null, sub = null, show = 10 } = {}) => {
    if (!list.length || list.every(r => !r.value)) return empty;
    const max = Math.max(...list.map(r => r.value));
    const item = r => {
      const name = label(r.key);
      const key = href ? html`<a href="${href(r.key)}">${name}</a>` : escape(name);
      return html`<li title="${name}"><span class="b" style="width:${Math.max(2, Math.round(r.value / max * 100))}%"></span><span class="k">${raw(key)}${raw(sub ? html`<span class="s">${sub(r)}</span>` : '')}</span><span class="n">${number(r.value)}${raw(total ? html`<span class="p">${Math.round(r.value / total * 100)}%</span>` : '')}</span></li>`;
    };
    const cut = list.length - show <= 2 ? list.length : show; // never fold just one or two rows
    const first = list.slice(0, cut).map(item).join(''), rest = list.slice(cut);
    return `<ul class="rows">${first}</ul>${rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary><ul class="rows">${rest.map(item).join('')}</ul></details>` : ''}`;
  };
  const partial = truncated => (truncated ? '<p class="banner">These numbers cover only the first rows of the period; choose a shorter range for complete results.</p>' : '');

  // Change against the previous period of the same length.
  const delta = (current, previous, rangeKey, { lowerIsBetter = false } = {}) => {
    const vs = `vs previous ${RANGE_NAMES[rangeKey]}`;
    if (current == null || previous == null) return html`<div class="d">&nbsp;</div>`;
    if (!previous) return html`<div class="d">${current ? `new · ${vs}` : vs}</div>`;
    const change = Math.round(((current - previous) / previous) * 100);
    if (!change) return html`<div class="d">no change · ${vs}</div>`;
    const good = lowerIsBetter ? change < 0 : change > 0;
    return html`<div class="d"><span class="${good ? 'up' : 'down'}">${change > 0 ? '↑' : '↓'} ${Math.abs(change)}%</span> ${vs}</div>`;
  };
  const kpi = (label, value, extra = '', href = null, title = '') => (href
    ? html`<a class="kpi" href="${href}" title="${title}"><div class="l">${label}</div><div class="v">${value}</div>${raw(extra)}</a>`
    : html`<div class="kpi" title="${title}"><div class="l">${label}</div><div class="v">${value}</div>${raw(extra)}</div>`);

  // Visitors (amber) over page views (soft amber) per bucket, drawn as an SVG without any script; hovering
  // a column shows its numbers. Axis labels are HTML so they stay readable at any width.
  const chart = (series, hourly) => {
    if (!series.length) return '';
    const top = (value => { const p = 10 ** Math.floor(Math.log10(value)); return [1, 2, 5, 10].map(m => m * p).find(n => n >= value); })(Math.max(2, ...series.map(s => s.pageViews)));
    const W = 1000, H = 180, slot = W / series.length, pad = Math.min(8, slot * 0.16);
    const y = value => H - (value / top) * H;
    const when = at => new Date(at).toLocaleString('en-US', hourly ? { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const columns = series.map((s, i) => {
      const x = i * slot + pad, w = slot - 2 * pad, inner = w * 0.5;
      return `<g><title>${escape(when(s.start))} UTC: ${number(s.visitors)} visitors, ${number(s.pageViews)} page views</title><rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${H}"/><rect class="pv" x="${x}" y="${y(s.pageViews)}" width="${w}" height="${H - y(s.pageViews)}"/><rect class="v" x="${x + (w - inner) / 2}" y="${y(s.visitors)}" width="${inner}" height="${H - y(s.visitors)}"/></g>`;
    }).join('');
    const grid = [0.5, 1].map(f => `<line class="g" x1="0" x2="${W}" y1="${H - f * H}" y2="${H - f * H}" vector-effect="non-scaling-stroke"/>`).join('');
    const every = Math.ceil(series.length / (hourly ? 6 : 8));
    return `<div class="chart"><div class="yax"><span>${number(top)}</span><span>${number(top / 2)}</span><span>0</span></div><div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Visitors and page views over time">${grid}${columns}</svg>
<div class="xax" style="grid-template-columns:repeat(${series.length},1fr)">${series.map((s, i) => `<span class="${i % (every * 2) === 0 ? 'major' : 'minor'}">${i % every === 0 ? escape(when(s.start)) : ''}</span>`).join('')}</div></div></div>`;
  };

  const siteHeader = (site, tab, rangeKey = '7d') => {
    const base = `/sites/${site.id}`;
    const tabs = [['overview', base, 'Overview'], ['bots', `${base}/bots`, 'Bots & AI'], ['settings', `${base}/settings`, 'Install & settings']];
    const domains = (site.origins || []).map(o => o.replace(/^https?:\/\//, '')).join(', ');
    return html`<div class="head"><div><h1>${site.name} ${raw(site.paused ? '<span class="tag">paused</span>' : '')}</h1><div class="sub">${domains}</div></div></div>
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
        return page('Set up', html`<div class="auth">${raw(MARK.replace('width="22" height="22"', 'width="44" height="44"'))}<h1>Set up</h1><p class="muted">Open the setup link of this installation, with its token, to create the owner account.</p></div>`, null, 403, {}, 'narrow');
      }
      if (!post) return page('Set up', authForm('Create account', '/setup', intro, null, '', token), null, 200, {}, 'narrow');
      const { email = '', password = '' } = fields;
      if (!email.includes('@') || password.length < 12) {
        return page('Set up', authForm('Create account', '/setup', intro, 'Use a valid email and a password of at least 12 characters.', email, token), null, 400, {}, 'narrow');
      }
      const user = await store.createUser(email.trim().toLowerCase(), await hashPassword(password));
      const session = await store.createSession(user.id);
      return redirect('/', { 'Set-Cookie': cookie(session.token, session.maxAge) });
    }

    if (path === '/login') {
      if (!(await store.hasUsers())) return redirect('/setup');
      const intro = 'Sign in to see your sites.';
      if (!post) return page('Sign in', authForm('Sign in', '/login', intro), null, 200, {}, 'narrow');
      const fields = await form(request);
      const email = String(fields.email || '').trim().toLowerCase();
      const blocked = failures.get(email);
      if (blocked && blocked.count >= 5 && blocked.until > Date.now()) {
        return page('Sign in', authForm('Sign in', '/login', intro, 'Too many attempts. Try again in a few minutes.', email), null, 429, {}, 'narrow');
      }
      const user = await store.findUserByEmail(email);
      if (!user || !(await verifyPassword(String(fields.password || ''), user.password))) {
        const entry = failures.get(email) || { count: 0 };
        failures.set(email, { count: entry.count + 1, until: Date.now() + 15 * 60_000 });
        return page('Sign in', authForm('Sign in', '/login', intro, 'Wrong email or password.', email), null, 401, {}, 'narrow');
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
      const cards = sites.map(s => html`<a class="card site" href="${url('/sites/' + s.id)}"><b>${s.name}</b> ${raw(s.paused ? '<span class="tag">paused</span>' : '')}<div class="muted" style="font-size:14px">${s.origins.map(o => o.replace(/^https?:\/\//, '')).join(', ')}</div><div class="note">ID <code>${s.id}</code></div><div class="go">Open dashboard →</div></a>`).join('');
      return page('Sites', html`<div class="head"><h1>Sites</h1><a class="button" style="margin:0" href="${url('/sites/new')}">Add a site</a></div>
${raw(sites.length ? html`<div class="sites">${raw(cards)}</div>` : '<div class="card"><p class="muted" style="margin:0">No sites yet. Add one to get its snippet.</p></div>')}`, user, 200, {}, true);
    }

    if (path === '/sites/new') {
      const body = (fields, error) => html`<div class="col"><div class="head"><h1>Add a site</h1></div>${raw(siteForm('/sites/new', fields, error))}</div>`;
      if (!post) return page('Add a site', body({}), user, 200, {}, true);
      const fields = await form(request);
      const name = String(fields.name || '').trim().slice(0, 100);
      const [origins, error] = parseOrigins(fields.origins);
      if (!name || error) return page('Add a site', body({ name, origins: String(fields.origins || '').split(/\s+/) }, error || 'Add a name'), user, 400, {}, true);
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
          return page(site.name, html`${raw(siteHeader(site, 'settings'))}<div class="col"><h2>Data retention</h2>${raw(retentionForm(site, 'Use a whole number of months between 1 and 120.'))}</div>`, user, 400, {}, true);
        }
        await store.updateSettings(site.id, { retention: months });
        return redirect(`${base}/settings`);
      }
      if (section === 'consent') {
        if (!post) return redirect(`${base}/settings`);
        const [consent, error] = parseConsent(await form(request));
        if (error) return page(site.name, html`${raw(siteHeader(site, 'settings'))}<div class="col"><h2>Consent</h2>${raw(consentForm(site, error))}</div>`, user, 400, {}, true);
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
          if (!name || error) return page(site.name, html`${raw(siteHeader(site, 'settings'))}<div class="col">${raw(siteForm(`${base}/settings`, { ...site, name }, error || 'Add a name'))}</div>`, user, 400, {}, true);
          await store.updateSite(site.id, { name, origins, paused: fields.paused === '1' });
          return redirect(`${base}/settings`);
        }
        const check = site.host ? checkInstall(site.host, await queries.installCheck(site.id, now() - 7 * 864e5, now())) : null;
        return page(site.name, html`${raw(siteHeader(site, 'settings'))}<div class="col">
<nav class="jump"><a href="#install">Install</a><a href="#consent">Consent</a><a href="#retention">Data retention</a><a href="#site">Site</a><a href="#delete">Delete</a></nav>
<p class="note">Site ID <code>${site.id}</code></p>
${raw(install(site, site.host, origin, check))}
<h2 id="consent">Consent</h2>${raw(consentForm(site))}
<h2 id="retention">Data retention</h2>${raw(retentionForm(site))}
<h2 id="site">Site</h2>${raw(siteForm(`${base}/settings`, site))}
<h2 id="delete">Delete</h2>
<form method="post" action="${url(`${base}/delete`)}" class="card danger-zone">
<p style="margin-top:0">Deletes the site and <strong>every event recorded for it</strong>. This can't be undone. Type the site's name to confirm.</p>
<input name="confirm" required aria-label="Site name" placeholder="${site.name}"><button class="danger">Delete site and data</button></form></div>`, user, 200, {}, true);
      }
      if (post) return new Response('Method Not Allowed', { status: 405 });

      const rangeKey = RANGES[searchParams.get('range')] ? searchParams.get('range') : '7d';
      const to = now();
      const span = RANGES[rangeKey];
      const from = to - span;
      // Report filters: consent state (docs/spec.md, section 5).
      const consentFilter = CONSENT_STATES.includes(searchParams.get('consent')) ? searchParams.get('consent') : null;
      const filter = { consent: consentFilter };
      const query = (changes = {}) => `?${new URLSearchParams(Object.entries({ range: rangeKey, consent: consentFilter, ...changes }).filter(([, v]) => v))}`;
      const ranges = html`<div class="seg" role="group" aria-label="Period">${raw(Object.keys(RANGES).map(k => html`<a class="${k === rangeKey ? 'on' : ''}" href="${url(path)}${query({ range: k })}">${k}</a>`).join(''))}</div>`;
      // The consent filter is secondary: a menu, and a chip to clear it while it's on.
      const consentMenu = html`<details class="menu"><summary>Consent: ${consentFilter ? CONSENT_LABELS[consentFilter] : 'all'}</summary><div class="pop">${raw([[null, 'All visitors'], ...CONSENT_STATES.map(s => [s, CONSENT_LABELS[s]])].map(([value, label]) => html`<a class="${value === consentFilter ? 'on' : ''}" href="${url(path)}${query({ consent: value })}">${label}</a>`).join(''))}</div></details>${raw(consentFilter ? html`<span class="chip">Only: ${CONSENT_LABELS[consentFilter]}<a href="${url(path)}${query({ consent: null })}" aria-label="Clear the consent filter">×</a></span>` : '')}`;

      if (section === 'bots') {
        const data = await queries.bots(site.id, from, to);
        const ai = data.categories.filter(c => c.key.startsWith('ai_')).reduce((a, c) => a + c.value, 0);
        const referred = data.aiReferrals.reduce((a, r) => a + r.value, 0);
        const botRows = rows(data.bots, { label: key => key, show: 12, sub: b => `${['other', 'unidentified'].includes(b.category || 'unidentified') ? '' : `${BOT_LABELS[b.category] || capital(b.category)} · `}last seen ${ago(b.last, to)}` });
        return page(`${site.name} · Bots & AI`, html`${raw(siteHeader(site, 'bots', rangeKey))}<div class="toolbar">${raw(ranges)}</div>
<section class="card hero"><div class="kpis">
${raw(kpi('Bot requests', number(data.total), '<div class="d">Not counted as visitors</div>'))}
${raw(kpi('From verified bots', number(data.verified.verified || 0), '<div class="d">Identity confirmed by the platform</div>'))}
${raw(kpi('AI crawler requests', number(ai), '<div class="d">Training, search and assistants</div>'))}
${raw(kpi('Visits sent by AI assistants', number(referred), '<div class="d">People arriving from ChatGPT and others</div>'))}
</div></section>
<div class="grid" style="margin-top:14px">
${raw(panel('By category', rows(data.categories, { total: data.total, label: key => BOT_LABELS[key] || capital(key) }), 'requests'))}
${raw(panel('Bots', botRows, 'requests'))}
${raw(panel('Most requested paths', rows(data.paths), 'requests'))}
${raw(panel('Special files', rows(data.specialFiles), 'requests'))}
${raw(panel('Visits sent by AI assistants', rows(data.aiReferrals), 'page views'))}
</div>
<details class="how"><summary>How bots are counted</summary><p>Bots are seen when a collector is in front of the site (every request) or when they run the script. Verified means the platform confirmed the bot's identity; the others are identified by user agent only. Special files are robots.txt, sitemaps, llms.txt and Markdown versions of pages. "Other" are page views whose user agent looks like a browser but that never ran the script nor loaded the noscript pixel: almost always bots, so they are not counted as visitors.</p></details>${raw(partial(data.truncated))}`, user, 200, {}, true);
      }

      if (eventName) {
        const data = await queries.event(site.id, eventName, from, to, filter);
        const props = data.properties.map(p => panel(html`${p.key} <span class="tag">${p.scope}</span>`, rows(p.values, { total: data.total }))).join('');
        return page(`${site.name} · ${eventName}`, html`${raw(siteHeader(site, 'overview', rangeKey))}
<p><a href="${url(base)}${query()}">← Overview</a></p>
<div class="head"><h1 style="font-size:20px">Event: ${eventName}</h1></div>
<div class="toolbar">${raw(ranges)}${raw(consentMenu)}</div>
<section class="card hero"><div class="kpis">${raw(kpi('Events', number(data.total)))}</div></section>
<div class="grid" style="margin-top:14px">${raw(props || panel('Attributes', empty))}</div>
<p class="note">Each attribute shows the scope it comes from. Page, session and user attributes apply to every event of that page view, session or user, including events sent before they were set.</p>${raw(partial(data.truncated))}`, user, 200, {}, true);
      }

      const hourly = rangeKey === '24h';
      const [data, previous, attrs] = await Promise.all([
        queries.overview(site.id, from, to, filter, { bucket: hourly ? 36e5 : 864e5 }),
        queries.overview(site.id, from - span, from, filter),
        queries.attributeSummary(site.id, from, to),
      ]);
      const t = data.totals, p = previous.totals;
      const eventRows = rows(data.events, { href: key => `${url(`${base}/events/${key}`)}${query()}` });
      const consentTotal = data.consent.reduce((a, r) => a + r.value, 0);
      const jsTotal = data.js.reduce((a, r) => a + r.value, 0);
      const jsLabels = { on: 'Script ran', off: 'JavaScript disabled (noscript pixel)', unknown: 'No script data (server only)' };
      const anyAttributes = ['page', 'session', 'user'].some(scope => attrs[scope].length);
      const scopePanels = ['page', 'session', 'user'].filter(scope => attrs[scope].length).map(scope => panel(`${capital(scope)} attributes`,
        attrs[scope].map(a => html`<p style="margin:14px 0 0"><strong>${a.key}</strong></p>${raw(rows(a.values))}`).join(''))).join('');
      const granted = consentTotal ? Math.round(((data.consent.find(r => r.key === 'granted') || { value: 0 }).value / consentTotal) * 100) : 0;
      return page(site.name, html`${raw(siteHeader(site, 'overview', rangeKey))}
<div class="toolbar">${raw(ranges)}${raw(consentMenu)}</div>${raw(partial(data.truncated || attrs.truncated))}
<section class="card hero"><div class="kpis">
${raw(kpi('Visitors', number(t.visitors), delta(t.visitors, p.visitors, rangeKey), null, `${number(t.stableVisitors)} recognized across days (a stable ID, with consent or where none is needed); the rest are daily unique visitors, summed, since without a stable ID a returning visitor counts once per day.`))}
${raw(kpi('Page views', number(t.pageViews), delta(t.pageViews, p.pageViews, rangeKey)))}
${raw(kpi('Sessions', number(t.sessions), delta(t.sessions, p.sessions, rangeKey)))}
${raw(kpi('Visible time per page', duration(t.avgVisibleMs), delta(t.avgVisibleMs, p.avgVisibleMs, rangeKey), null, `Over ${number(t.timedPageViews)} page views with engagement data.`))}
${raw(kpi('Bot requests', number(t.bots), html`<div class="d">Kept out of the numbers above →</div>`, `${url(`${base}/bots`)}?range=${rangeKey}`, `Not included in any other number here. ${t.unconfirmed ? `Includes ${number(t.unconfirmed)} page views that never ran the script, counted as other bots.` : ''}`))}
</div>
<div class="plotwrap"><div class="legend"><span><i style="background:var(--beam)"></i>Visitors</span><span><i style="background:var(--beam-mid)"></i>Page views</span><span>${hourly ? 'per hour' : 'per day'}, UTC</span></div>${raw(chart(data.series, hourly))}</div>
</section>
<h2>Content and sources</h2>
<div class="grid">
${raw(panel('Pages', rows(data.pages, { total: t.pageViews }), 'page views'))}
${raw(panel('Sources', rows(data.referrerTypes, { total: data.referrerTypes.reduce((a, r) => a + r.value, 0), label: key => SOURCE_LABELS[key] || capital(key) }), 'sessions'))}
${raw(panel('Referrers', rows(data.referrers), 'sessions'))}
${raw(panel('Campaigns', rows(data.campaigns), 'sessions'))}
</div>
<h2>Audience</h2>
<div class="grid">
${raw(panel('Countries', rows(data.countries, { total: t.pageViews, label: regionName }), 'page views'))}
${raw(panel('Devices', rows(data.devices, { total: t.pageViews, label: capital }), 'page views'))}
${raw(panel('Browsers', rows(data.browsers, { total: t.pageViews }), 'page views'))}
${raw(panel('Operating systems', rows(data.os, { total: t.pageViews }), 'page views'))}
</div>
<h2>Engagement</h2>
<div class="grid">
${raw(panel('Scroll depth', rows(data.scrollDepth, { total: data.scrolledPageViews, label: key => `Reached ${key}` }) + html`<p class="note">Deepest point reached, over ${number(data.scrolledPageViews)} page views with engagement data.</p>`, 'page views'))}
${raw(panel('Events', eventRows, 'events'))}
</div>
${raw(anyAttributes ? html`<h2>Attributes</h2><div class="grid">${raw(scopePanels)}</div><p class="note">Current values: how many page views, sessions or users have each one.</p>` : '')}
<h2>Measurement and privacy</h2>
<div class="grid">
${raw(panel('JavaScript', rows(data.js, { total: jsTotal, label: key => jsLabels[key] || key }), 'page views'))}
${raw(panel('Consent', rows(data.consent, { total: consentTotal, label: key => CONSENT_LABELS[key] || key })
  + html`<p class="note">Page views by consent state. Sessions:</p>` + rows(data.consentSessions, { label: key => CONSENT_LABELS[key] || key })
  + html`<details class="how"><summary>How to read this</summary><p>Refusals have no sessions: they are counted without any identifier. Visitors who accept are recognized across days; the others only within a day, so a report on accepted visitors only covers ${granted}% of page views, and they may not behave like everyone else.</p></details>`, 'page views'))}
</div>`, user, 200, {}, true);
    }

    return page('Not found', '<h1>Page not found</h1>', user, 404);
  }

  return {
    handle: request => routes(request),
    queries,
    basePath,
  };
}
