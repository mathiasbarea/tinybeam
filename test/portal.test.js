import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTinybeam } from '../app.js';
import { hashPassword, verifyPassword } from '../portal/auth.js';
import { parseOrigins } from '../portal/index.js';
import { sqliteDriver } from '../collector/node.js';

const ORIGIN = 'https://analytics.example.com';

// A Tinybeam app on in-memory SQLite, and a tiny browser: keeps the session cookie and sends forms from the
// portal's own origin.
async function setup() {
  const driver = await sqliteDriver(':memory:');
  const app = createTinybeam({ driver, script: '/* tinybeam */' });
  let cookie = '';
  const request = async (path, { form, headers = {}, method } = {}) => {
    const init = { method: method || (form ? 'POST' : 'GET'), headers: { cookie, ...headers } };
    if (form) {
      init.body = new URLSearchParams(form);
      init.headers.origin ??= ORIGIN;
    }
    const res = await app.handle(new Request(ORIGIN + path, init));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  return { app, driver, request, text: async res => res.text() };
}

const PASSWORD = 'correct horse battery';

async function signedIn() {
  const ctx = await setup();
  await ctx.request('/portal/setup', { form: { email: 'Owner@Example.com', password: PASSWORD } });
  return ctx;
}

async function addSite(request, name = 'Example', origins = 'https://example.com') {
  const res = await request('/portal/sites/new', { form: { name, origins } });
  assert.equal(res.status, 303);
  return res.headers.get('location').match(/sites\/([a-z0-9]+)/)[1];
}

test('passwords are hashed with a salt and verified', async () => {
  const hash = await hashPassword('secret-password', 1000);
  assert.match(hash, /^pbkdf2\$1000\$/);
  assert.notEqual(await hashPassword('secret-password', 1000), hash);
  assert.equal(await verifyPassword('secret-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('first run asks for the owner account, and setup closes once it exists', async () => {
  const { request, text } = await setup();
  const first = await request('/portal/');
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/portal/setup');
  assert.equal((await request('/portal/setup', { form: { email: 'a@b.co', password: 'short' } })).status, 400);
  const created = await request('/portal/setup', { form: { email: 'Owner@Example.com', password: PASSWORD } });
  assert.equal(created.status, 303);
  assert.match(created.headers.get('set-cookie'), /tb_session=.+; Path=\/portal; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
  assert.match(await text(await request('/portal/')), /owner@example\.com/);
  assert.equal((await request('/portal/setup')).headers.get('location'), '/portal/login', 'setup is closed');
});

test('signing in and out, with wrong passwords rejected and repeated guessing slowed down', async () => {
  const { request } = await signedIn();
  await request('/portal/logout', { form: {} });
  assert.equal((await request('/portal/')).headers.get('location'), '/portal/login');
  assert.equal((await request('/portal/login', { form: { email: 'owner@example.com', password: 'nope' } })).status, 401);
  assert.equal((await request('/portal/login', { form: { email: 'owner@example.com', password: PASSWORD } })).status, 303);
  assert.equal((await request('/portal/')).status, 200);
  for (let i = 0; i < 5; i++) await request('/portal/login', { form: { email: 'owner@example.com', password: 'nope' } });
  assert.equal((await request('/portal/login', { form: { email: 'owner@example.com', password: PASSWORD } })).status, 429);
});

test('form posts from another origin are refused', async () => {
  const { request } = await signedIn();
  const res = await request('/portal/sites/new', { form: { name: 'X', origins: 'https://x.example' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('a site added in the portal gets an ID and a snippet, and the collector accepts it', async () => {
  const { app, driver, request, text } = await signedIn();
  const id = await addSite(request, 'Example <b>', 'https://example.com/some/page\nhttps://www.example.com');
  assert.match(id, /^[a-z0-9]{12}$/);
  await request(`/portal/sites/${id}/install`, { form: { host: 'self' } });
  const page = await text(await request(`/portal/sites/${id}/settings`));
  assert.match(page, new RegExp(`data-site=&quot;${id}&quot;`));
  assert.match(page, /Example &lt;b&gt;/, 'names are escaped');
  assert.doesNotMatch(page, /Example <b>/);
  const [site] = await app.store.listSites();
  assert.deepEqual(site.origins, ['https://example.com', 'https://www.example.com']);

  const batch = { v: 1, s: id, u: 'https://www.example.com/', pv: 'p', e: [{ n: 'page_view', t: 1, p: { title: 'Home' } }] };
  const sent = await app.handle(new Request(ORIGIN + '/tb/e', { method: 'POST', body: JSON.stringify(batch) }));
  assert.equal(sent.status, 204);
  assert.equal(driver.all('SELECT site, title FROM tinybeam_events', [])[0].site, id);

  const script = await app.handle(new Request(ORIGIN + '/tb/tinybeam.js'));
  assert.equal(await script.text(), '/* tinybeam */');
});

test('a paused site is rejected by the collector; deleting needs the name and removes its data', async () => {
  const { app, driver, request } = await signedIn();
  const id = await addSite(request);
  const send = () => app.handle(new Request(ORIGIN + '/tb/e', { method: 'POST', body: JSON.stringify({ v: 1, s: id, u: 'https://example.com/', e: [{ n: 'x', t: 1, p: {} }] }) }));
  assert.equal((await send()).status, 204);
  await request(`/portal/sites/${id}/settings`, { form: { name: 'Example', origins: 'https://example.com', paused: '1' } });
  assert.equal((await app.store.getSite(id)).paused, true);
  assert.equal((await send()).status, 403);

  await request(`/portal/sites/${id}/delete`, { form: { confirm: 'wrong' } });
  assert.ok(await app.store.getSite(id), 'not deleted without the right name');
  await request(`/portal/sites/${id}/delete`, { form: { confirm: 'Example' } });
  assert.equal(await app.store.getSite(id), null);
  assert.equal(driver.all('SELECT COUNT(*) AS n FROM tinybeam_events WHERE site = ?', [id])[0].n, 0);
});

test('invalid site forms explain what is wrong', async () => {
  const { request, text } = await signedIn();
  const res = await request('/portal/sites/new', { form: { name: 'X', origins: 'ftp://files.example' } });
  assert.equal(res.status, 400);
  assert.match(await text(res), /must start with http/);
  assert.deepEqual(parseOrigins('https://a.example/x  https://a.example'), [['https://a.example'], null]);
  assert.equal(parseOrigins('')[1], 'Add at least one origin');
});

test('pages need a session', async () => {
  const { request } = await setup();
  await request('/portal/setup', { form: { email: 'owner@example.com', password: PASSWORD } });
  const fresh = await setup();
  assert.equal((await fresh.request('/portal/sites/new')).status, 303);
});

test('installation asks where the site is hosted and shows only what fits there', async () => {
  const { request, text } = await signedIn();
  const id = await addSite(request);
  const settings = async () => text(await request(`/portal/sites/${id}/settings`));
  assert.match(await settings(), /Where is the site hosted\?/);
  assert.doesNotMatch(await settings(), /data-site=/, 'no snippet until the host is known');

  await request(`/portal/sites/${id}/install`, { form: { host: 'vercel' } });
  const vercel = await settings();
  assert.match(vercel, /vercel\.json/);
  assert.match(vercel, /&quot;destination&quot;: &quot;https:\/\/analytics\.example\.com\/tb\/:path\*&quot;/);
  assert.match(vercel, /src=&quot;\/tb\/tinybeam\.js&quot;/, 'the script from the site\'s own domain');
  assert.match(vercel, /13 months/);

  await request(`/portal/sites/${id}/install`, { form: { host: 'php' } });
  const php = await settings();
  assert.match(php, /examples\/endpoint\/id\.php/);
  assert.match(php, /tinybeam-ids\.js&quot; data-site=&quot;[a-z0-9]+&quot; data-endpoint=&quot;https:\/\/analytics\.example\.com\/tb\/e&quot; data-id=&quot;endpoint&quot;/);

  await request(`/portal/sites/${id}/install`, { form: { host: 'wordpress' } });
  assert.match(await settings(), /Settings &gt; Tinybeam/);

  await request(`/portal/sites/${id}/install`, { form: { host: 'nocode' } });
  const nocode = await settings();
  assert.match(nocode, /data-id=&quot;script&quot;/);
  assert.match(nocode, /7 days in Safari/);
});

test('consent settings are saved, validated, and change the snippet when the banner is on', async () => {
  const { app, request, text } = await signedIn();
  const id = await addSite(request);
  await request(`/portal/sites/${id}/install`, { form: { host: 'self' } });
  const bad = await request(`/portal/sites/${id}/consent`, { form: { mode: 'region', regions: 'DE FRA' } });
  assert.equal(bad.status, 400);
  assert.match(await text(bad), /&quot;FRA&quot; is not a two-letter country code/);
  await request(`/portal/sites/${id}/consent`, { form: { mode: 'all', regions: 'de, fr br', onRefusal: 'drop', banner: '1', bannerLanguage: 'auto', defaultLanguage: 'es', privacy: 'es https://example.com/privacidad', position: 'bottom-left', color: '#ff0000' } });
  const site = await app.store.getSite(id);
  assert.deepEqual(site.consent, { mode: 'all', regions: ['DE', 'FR', 'BR'], onRefusal: 'drop', banner: true, bannerLanguage: 'auto', defaultLanguage: 'es', privacy: { es: 'https://example.com/privacidad' }, position: 'bottom-left', color: '#ff0000' });
  assert.match(await text(await request(`/portal/sites/${id}/settings`)), /data-consent=&quot;auto&quot;/);

  // The collector reads the new settings: everyone is asked now, even in the US.
  const res = await app.handle(new Request(`${ORIGIN}/tb/c?s=${id}&u=https%3A%2F%2Fexample.com%2F`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' } }), { country: 'US' });
  assert.deepEqual(await res.json(), { c: 'pending' });
});

test('banner texts can be edited per language, and new languages added', async () => {
  const { app, request, text } = await signedIn();
  const id = await addSite(request);
  const page = await text(await request(`/portal/sites/${id}/banner?lang=es`));
  assert.match(page, /placeholder="Aceptar"/, 'the built-in translation as a hint');
  await request(`/portal/sites/${id}/banner`, { form: { lang: 'es', accept: 'Dale', reject: '' } });
  await request(`/portal/sites/${id}/banner`, { form: { lang: 'ja', accept: '同意する' } });
  const site = await app.store.getSite(id);
  assert.deepEqual(site.consent.texts, { es: { accept: 'Dale' }, ja: { accept: '同意する' } });
  const preview = await text(await request(`/portal/sites/${id}/banner?lang=es`));
  assert.match(preview, />Dale</);
  assert.match(preview, />Rechazar</);
  assert.match(preview, /href="\/portal\/sites\/[a-z0-9]+\/banner\?lang=ja"/, 'the added language is listed');
});

test('with a setup token, only the setup link can create the owner account', async () => {
  const driver = await sqliteDriver(':memory:');
  const app = createTinybeam({ driver, script: '', setupToken: 'link-token-123' });
  const send = (path, form) => app.handle(new Request(ORIGIN + path, form ? { method: 'POST', body: new URLSearchParams(form), headers: { origin: ORIGIN } } : {}));
  assert.equal((await send('/portal/setup')).status, 403);
  assert.equal((await send('/portal/setup', { email: 'a@b.co', password: PASSWORD })).status, 403);
  assert.equal((await send('/portal/setup', { email: 'a@b.co', password: PASSWORD, token: 'wrong' })).status, 403);
  assert.match(await (await send('/portal/setup?token=link-token-123')).text(), /name="token" value="link-token-123"/);
  assert.equal((await send('/portal/setup', { email: 'a@b.co', password: PASSWORD, token: 'link-token-123' })).status, 303);
  assert.equal((await send('/portal/setup?token=link-token-123')).headers.get('location'), '/portal/login', 'closed once the owner exists');
});
