import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, createIdEndpoint, memoryStorage, sqlStorage } from '../collector/index.js';
import { pickLanguage, renderBanner } from '../collector/banner.js';
import { consentRequired, CONSENT_DEFAULTS } from '../collector/consent.js';
import { sqliteDriver } from '../collector/node.js';

const ORIGIN = 'https://example.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function setup(consent = {}) {
  const storage = memoryStorage();
  const sites = [{ id: 'site1', origins: [ORIGIN], consent: { banner: true, ...consent } }];
  const collector = createCollector({ storage, sites });
  // A tiny browser: keeps the cookies the collector sets, like a real one would on the site's domain.
  const jar = new Map();
  const remember = res => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split('; ');
      const [name, value] = pair.split('=');
      if (attrs.includes('Max-Age=0')) jar.delete(name); else jar.set(name, value);
    }
    return res;
  };
  const headers = (extra = {}) => ({ 'user-agent': UA, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extra });
  const send = async (events, { country = 'DE', extra = {}, body = {} } = {}) => remember(await collector.handle(new Request(`${ORIGIN}/tb/e`, {
    method: 'POST', headers: headers(extra), body: JSON.stringify({ v: 1, s: 'site1', u: `${ORIGIN}/`, pv: 'p1', e: events, ...body }),
  }), { ip: '203.0.113.9', country }));
  const decide = async (c, { country = 'DE', body = {} } = {}) => remember(await collector.handle(new Request(`${ORIGIN}/tb/c`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ s: 'site1', u: `${ORIGIN}/`, c, src: 'banner', ...body }),
  }), { ip: '203.0.113.9', country }));
  const get = async (path, { country = 'DE', extra = {} } = {}) => remember(await collector.handle(new Request(ORIGIN + path, { headers: headers(extra) }), { ip: '203.0.113.9', country }));
  return { collector, records: storage.records, jar, send, decide, get };
}
const view = [{ n: 'page_view', t: 1, p: { title: 'Home' } }];
const last = records => records[records.length - 1];

test('regions: consent is required in the EU, the UK, Switzerland and unknown countries by default', () => {
  assert.equal(consentRequired(CONSENT_DEFAULTS, 'DE'), true);
  assert.equal(consentRequired(CONSENT_DEFAULTS, 'gb'), true);
  assert.equal(consentRequired(CONSENT_DEFAULTS, 'CH'), true);
  assert.equal(consentRequired(CONSENT_DEFAULTS, null), true, 'unknown country');
  assert.equal(consentRequired(CONSENT_DEFAULTS, 'US'), false);
  assert.equal(consentRequired({ ...CONSENT_DEFAULTS, mode: 'all' }, 'US'), true);
  assert.equal(consentRequired({ ...CONSENT_DEFAULTS, mode: 'full' }, 'DE'), false);
  assert.equal(consentRequired({ ...CONSENT_DEFAULTS, regions: ['BR'] }, 'BR'), true, 'editable regions');
});

test('without a decision: pending and the daily hash where consent is required, a stable ID elsewhere', async () => {
  const eu = setup();
  await eu.send(view, { country: 'DE' });
  const pending = last(eu.records);
  assert.deepEqual([pending.consent, pending.ads_consent, pending.id_store], ['pending', 'pending', null]);
  assert.match(pending.aid, /^[0-9a-f]{32}$/);
  assert.ok(pending.sid);
  assert.equal(eu.jar.size, 0, 'nothing is stored in the browser');

  const us = setup();
  await us.send(view, { country: 'US' });
  assert.deepEqual([last(us.records).consent, last(us.records).id_store], ['not_required', 'collector']);
  assert.equal(us.jar.get('tb_id'), last(us.records).aid, 'the stable ID is the day\'s hash, kept in a cookie');
  assert.equal(us.jar.get('tb_c'), '--', 'marks that no decision is needed, so the script doesn\'t ask');
  await us.send(view, { country: 'US' });
  assert.equal(last(us.records).aid, us.jar.get('tb_id'), 'later requests use the cookie');
});

test('Global Privacy Control: no identifier where consent is required, the daily hash elsewhere, never ads', async () => {
  const eu = setup();
  await eu.send(view, { country: 'FR', extra: { 'sec-gpc': '1' } });
  assert.deepEqual([last(eu.records).consent, last(eu.records).aid, last(eu.records).sid], ['gpc', null, null]);
  const us = setup();
  await us.send(view, { country: 'US', extra: { 'sec-gpc': '1' } });
  assert.equal(last(us.records).consent, 'gpc');
  assert.equal(last(us.records).ads_consent, 'gpc');
  assert.match(last(us.records).aid, /^[0-9a-f]{32}$/);
  assert.equal(us.jar.has('tb_id'), false);
});

test('accepting records the proof, sets the cookies and keeps the session', async () => {
  const { records, jar, send, decide } = setup();
  await send(view);
  const before = last(records);
  const res = await decide('11');
  assert.deepEqual(await res.json(), { c: 'granted' });
  assert.match(res.headers.getSetCookie().find(c => c.startsWith('tb_c=')), /^tb_c=11; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/, 'readable by the script, not HttpOnly');
  assert.match(res.headers.getSetCookie().find(c => c.startsWith('tb_id=')), /HttpOnly/);
  const proof = last(records);
  assert.deepEqual([proof.kind, proof.name, proof.props], ['set', '$consent', { analytics: true, ads: true, source: 'banner' }]);
  assert.equal(proof.aid, jar.get('tb_id'));
  await send([{ n: 'click', t: 2, p: {} }]);
  const after = last(records);
  assert.deepEqual([after.consent, after.ads_consent, after.id_store], ['granted', 'granted', 'collector']);
  assert.equal(after.sid, before.sid, 'same session before and after accepting');
});

test('refusing: the proof carries no identifier, and later events none either', async () => {
  const { records, jar, send, decide } = setup();
  await send(view);
  await decide('00');
  const proof = last(records);
  assert.deepEqual([proof.name, proof.aid, proof.sid, proof.props.analytics], ['$consent', null, null, false]);
  assert.equal(jar.get('tb_c'), '00');
  await send(view);
  const after = last(records);
  assert.deepEqual([after.consent, after.ads_consent, after.aid, after.sid, after.path], ['denied', 'denied', null, null, '/'], 'counted without an identifier');
});

test('withdrawing deletes the ID cookie; analytics without ads keeps the ID but not the ads', async () => {
  const { records, jar, send, decide } = setup();
  await decide('10');
  assert.ok(jar.has('tb_id'));
  await send(view);
  assert.deepEqual([last(records).consent, last(records).ads_consent], ['granted', 'denied']);
  await decide('00');
  assert.equal(jar.has('tb_id'), false);
});

test('a site can choose not to measure refusals at all: only the decision is kept', async () => {
  const { records, send, decide } = setup({ onRefusal: 'drop' });
  await decide('00');
  const count = records.length;
  await send(view);
  assert.equal(records.length, count);
  assert.equal(last(records).name, '$consent');
});

test('modes: ask everyone, never ask with full measurement, and never ask anonymous-only', async () => {
  const all = setup({ mode: 'all' });
  await all.send(view, { country: 'US' });
  assert.equal(last(all.records).consent, 'pending');
  const full = setup({ mode: 'full' });
  await full.send(view, { country: 'DE' });
  assert.equal(last(full.records).consent, 'not_required');
  const anonymous = setup({ mode: 'anonymous' });
  await anonymous.send(view, { country: 'US' });
  assert.deepEqual([last(anonymous.records).consent, last(anonymous.records).id_store], ['pending', null]);
  assert.deepEqual(await (await anonymous.get('/tb/c?s=site1&u=https%3A%2F%2Fexample.com%2F', { country: 'US' })).json(), { c: 'none' }, 'nothing to ask');
});

test('ID kept by the script or the site\'s endpoint: the batch carries it, and the collector still applies the region', async () => {
  const { records, send } = setup();
  const id = 'k3j2h1g0f9e8d7c6b5a4';
  await send(view, { country: 'DE', body: { is: 's', i: id, c: '11' } });
  assert.deepEqual([last(records).aid, last(records).id_store, last(records).consent], [id, 'script', 'granted']);
  await send(view, { country: 'DE', body: { is: 'e', i: id } });
  assert.deepEqual([last(records).id_store, last(records).consent], [null, 'pending'], 'without a decision the ID is ignored where consent is required');
  assert.notEqual(last(records).aid, id);
  await send(view, { country: 'US', body: { is: 'e', i: id } });
  assert.deepEqual([last(records).aid, last(records).id_store], [id, 'endpoint']);
  await send(view, { country: 'US', body: { is: 'e', i: 'not valid!' } });
  assert.equal(last(records).id_store, null);
});

test('GET /tb/c tells the script what to do', async () => {
  const eu = setup();
  const url = '/tb/c?s=site1&u=https%3A%2F%2Fexample.com%2F';
  assert.deepEqual(await (await eu.get(url, { country: 'DE' })).json(), { c: 'pending' });
  assert.deepEqual(await (await eu.get(url, { country: 'DE', extra: { 'sec-gpc': '1' } })).json(), { c: 'denied' });
  assert.deepEqual(await (await eu.get(url + '&m=s', { country: 'US' })).json(), { c: 'not_required' });
  assert.equal((await eu.get('/tb/c?s=site1&u=https%3A%2F%2Fevil.example%2F')).status, 403);
});

test('the banner is served only to visitors who must be asked, in their language', async () => {
  const { get, decide } = setup({ privacy: { es: 'https://example.com/privacidad' } });
  const shown = await (await get('/tb/banner.js?s=site1&l=es-AR,en-US', { country: 'ES' })).text();
  assert.match(shown, /"accept":"Aceptar"/);
  assert.match(shown, /"privacy":"https:\/\/example.com\/privacidad"/);
  assert.equal(await (await get('/tb/banner.js?s=site1&l=en', { country: 'US' })).text(), '', 'no one to ask in the US');
  await decide('10', { country: 'ES' });
  assert.equal(await (await get('/tb/banner.js?s=site1&l=en', { country: 'ES' })).text(), '', 'already decided');
  assert.match(await (await get('/tb/banner.js?s=site1&l=en&f=1', { country: 'ES' })).text(), /"accept":"Accept"/, 'a privacy settings click opens it anyway');
  const res = await get('/tb/banner.js?s=site1&l=en', { country: 'ES' });
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const off = setup({ banner: false });
  assert.equal(await (await off.get('/tb/banner.js?s=site1&l=en&f=1', { country: 'ES' })).text(), '', 'a site without Tinybeam\'s banner gets none');
});

test('banner language: the site\'s fixed one, else the page\'s or the browser\'s, else the default', () => {
  const settings = { ...CONSENT_DEFAULTS, defaultLanguage: 'en' };
  assert.equal(pickLanguage(settings, 'pt-BR,en'), 'pt');
  assert.equal(pickLanguage(settings, ',de-DE'), 'de', 'no page language: the browser\'s');
  assert.equal(pickLanguage(settings, 'ja,ko'), 'en');
  assert.equal(pickLanguage({ ...settings, bannerLanguage: 'fr' }, 'es'), 'fr');
  const custom = { ...settings, texts: { ja: { accept: '同意する' }, es: { accept: 'Dale' } } };
  assert.equal(pickLanguage(custom, 'ja'), 'ja', 'languages the owner added');
  assert.match(renderBanner(custom, 'ja'), /"accept":"同意する","reject":"Reject"/, 'missing texts fall back to English');
  assert.match(renderBanner(custom, 'es'), /"accept":"Dale","reject":"Rechazar"/, 'owner texts over the translation');
  assert.doesNotMatch(renderBanner({ ...settings, texts: { en: { title: '</script><script>alert(1)' } } }, 'en'), /<\/script>/);
});

test('the ID endpoint keeps the ID in cookies the script can read, and generates it itself', async () => {
  const handle = createIdEndpoint();
  const call = (method, body, cookie = '', origin = ORIGIN) => handle(new Request(`${ORIGIN}/tb/id`, { method, body, headers: { cookie, origin } }));
  assert.deepEqual(await (await call('GET')).json(), { i: null, c: null });
  const created = await call('POST', '{}');
  const { i } = await created.json();
  assert.match(i, /^[a-z0-9]{16,40}$/);
  const set = created.headers.getSetCookie();
  assert.ok(set.some(c => c.startsWith(`tb_id=${i}; `) && !c.includes('HttpOnly')));
  assert.ok(set.some(c => c.startsWith('tb_r=1;')), 'renewed today');
  assert.deepEqual(await (await call('POST', '{"analytics":true,"ads":false}', `tb_id=${i}`)).json(), { i, c: '10' });
  const refused = await call('POST', '{"analytics":false}', `tb_id=${i}`);
  assert.deepEqual(await refused.json(), { i: null, c: '00' });
  assert.ok(refused.headers.getSetCookie().some(c => c.startsWith('tb_id=; ') && c.includes('Max-Age=0')));
  assert.equal((await call('POST', '{}', '', 'https://evil.example')).status, 403);
});

test('tables from before consent get the new columns', async () => {
  const driver = await sqliteDriver(':memory:');
  driver.exec('CREATE TABLE tinybeam_events (received_at INTEGER, site TEXT)');
  await sqlStorage(driver).ready();
  const columns = driver.all('PRAGMA table_info(tinybeam_events)', []).map(c => c.name);
  for (const name of ['consent', 'ads_consent', 'id_store', 'uid']) assert.ok(columns.includes(name), name);
});

test('the banner\'s buttons send the decision through tinybeam.consent, and it goes away', async () => {
  const { JSDOM } = await import('jsdom');
  const run = () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const calls = [];
    dom.window.tinybeam = { consent: c => calls.push({ ...c }) }; // copied out of the page's realm
    dom.window.eval(renderBanner({ ...CONSENT_DEFAULTS, position: 'bottom-left' }, 'en'));
    const box = dom.window.document.getElementById('tb-consent');
    const buttons = [...box.querySelectorAll('button')];
    return { dom, calls, box, buttons };
  };
  const reject = run();
  assert.deepEqual(reject.buttons.map(b => b.textContent), ['Reject', 'Choose', 'Accept'], 'reject as prominent as accept, first');
  reject.buttons[0].click();
  assert.deepEqual(reject.calls, [{ analytics: false, ads: false, source: 'banner' }]);
  assert.equal(reject.dom.window.document.getElementById('tb-consent'), null);

  const choose = run();
  choose.buttons[1].click();
  assert.equal(choose.buttons[1].textContent, 'Save choices');
  choose.box.querySelectorAll('input')[0].checked = true;
  choose.buttons[1].click();
  assert.deepEqual(choose.calls, [{ analytics: true, ads: false, source: 'banner' }]);

  const accept = run();
  accept.buttons[2].click();
  assert.deepEqual(accept.calls, [{ analytics: true, ads: true, source: 'banner' }]);
});
