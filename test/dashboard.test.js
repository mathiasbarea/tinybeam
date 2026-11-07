import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTinybeam } from '../app.js';
import { sqliteDriver } from '../collector/node.js';

const ORIGIN = 'https://analytics.example.com';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// An app with one site and a realistic mix of traffic: two visitors, a server-side page view merged with
// the script's, a visitor without JavaScript, custom events, attributes set after events, and bots.
async function seeded() {
  const driver = await sqliteDriver(':memory:');
  const app = createTinybeam({ driver });
  const site = await app.store.createSite({ name: 'Example', origins: ['https://example.com'] });
  const send = (ua, ip, body) => app.handle(new Request('https://example.com/tb/e', {
    method: 'POST', headers: { 'user-agent': ua }, body: JSON.stringify({ v: 1, s: site.id, ...body }),
  }), { ip, country: ip === '1.1.1.1' ? 'UY' : 'AR' });
  const page = (path, ua) => new Request('https://example.com' + path, { headers: { 'user-agent': ua } });
  const html = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });

  // Visitor A: the server saw the page and gave it pv "a1"; the script reports the same page view.
  await app.collector.observe(page('/', CHROME), html(), { site: site.id, ip: '1.1.1.1', country: 'UY', pv: 'a1' });
  await send(CHROME, '1.1.1.1', { u: 'https://example.com/?utm_source=news&utm_campaign=launch', pv: 'a1', e: [
    { n: 'page_view', t: 1, p: { title: 'Home', ref: 'https://chatgpt.com/' } },
    { n: 'video_play', t: 2, p: { video: 'intro' } },
    { n: '$page', t: 3, p: { page_type: 'home' } }, // set after the event: still applies to it
    { n: '$session', t: 4, p: { experiment: 'b' } },
    { n: 'engagement', t: 5, p: { ms: 30_000, scroll: 75 } },
  ] });
  await send(CHROME, '1.1.1.1', { u: 'https://example.com/pricing/', pv: 'a2', e: [
    { n: 'page_view', t: 6, p: { title: 'Pricing', ref: 'https://example.com/' } },
    { n: 'video_play', t: 7, p: { video: 'demo' } },
    { n: '$user', t: 8, p: { id: 'u1', plan: 'pro' } },
    { n: 'engagement', t: 9, p: { ms: 10_000, scroll: 100 } },
  ] });
  // Visitor B on an iPhone.
  await send(IPHONE, '2.2.2.2', { u: 'https://example.com/pricing/', pv: 'b1', e: [{ n: 'page_view', t: 1, p: { title: 'Pricing', ref: 'https://www.google.com/' } }] });
  // Visitor C without JavaScript (noscript pixel).
  await app.handle(new Request(`https://example.com/tb/n?s=${site.id}`, { headers: { referer: 'https://example.com/about/', 'user-agent': CHROME } }), { ip: '3.3.3.3', country: 'AR' });
  // Bots.
  for (const [path, ua] of [['/', 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'], ['/llms.txt', 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'], ['/', 'facebookexternalhit/1.1']]) {
    await app.collector.observe(page(path, ua), html(), { site: site.id, ip: '9.9.9.9' });
  }
  return { app, site };
}

const DAY = 864e5;

test('the overview merges server and script page views and counts each visitor and source', async () => {
  const { app, site } = await seeded();
  const queries = app.portal.queries;
  const data = await queries.overview(site.id, Date.now() - DAY, Date.now() + DAY);
  assert.deepEqual(data.totals, { pageViews: 4, visitors: 3, stableVisitors: 3, sessions: 3, avgVisibleMs: 20_000, timedPageViews: 2, bots: 3 });
  assert.deepEqual(data.pages, [{ key: '/pricing/', value: 2 }, { key: '/', value: 1 }, { key: '/about/', value: 1 }]);
  assert.deepEqual(Object.fromEntries(data.referrerTypes.map(r => [r.key, r.value])), { ai_assistant: 1, search: 1, direct: 1 });
  assert.deepEqual(data.campaigns, [{ key: 'news / launch', value: 1 }]);
  assert.deepEqual(Object.fromEntries(data.js.map(r => [r.key, r.value])), { on: 3, off: 1 });
  assert.deepEqual(data.events, [{ key: 'video_play', value: 2 }]);
  assert.deepEqual(data.scrollDepth.find(r => r.key === '75%'), { key: '75%', value: 1 });
});

test('event breakdowns include page, session and user attributes, even when set after the event', async () => {
  const { app, site } = await seeded();
  const data = await app.portal.queries.event(site.id, 'video_play', Date.now() - DAY, Date.now() + DAY);
  const byKey = Object.fromEntries(data.properties.map(p => [p.key, p]));
  assert.equal(data.total, 2);
  assert.equal(byKey.video.scope, 'event');
  assert.deepEqual(byKey.page_type, { key: 'page_type', scope: 'page', values: [{ key: 'home', value: 1 }] });
  assert.deepEqual(byKey.experiment.values, [{ key: 'b', value: 2 }], 'session attribute covers both pages');
  assert.equal(byKey.experiment.scope, 'session');
  assert.deepEqual(byKey.plan, { key: 'plan', scope: 'user', values: [{ key: 'pro', value: 2 }] });
});

test('bots are counted apart, by category and name, with special files', async () => {
  const { app, site } = await seeded();
  const data = await app.portal.queries.bots(site.id, Date.now() - DAY, Date.now() + DAY);
  assert.equal(data.total, 3);
  assert.deepEqual(Object.fromEntries(data.categories.map(r => [r.key, r.value])), { ai_training: 2, social_preview: 1 });
  assert.deepEqual(data.specialFiles, [{ key: 'llms.txt · GPTBot', value: 1 }]);
  assert.deepEqual(data.aiReferrals, [{ key: 'chatgpt.com', value: 1 }]);
});

test('the dashboard pages render for the signed-in owner, escaping what visitors sent', async () => {
  const { app, site } = await seeded();
  await app.collector.handle(new Request('https://example.com/tb/e', { method: 'POST', headers: { 'user-agent': CHROME }, body: JSON.stringify({ v: 1, s: site.id, u: 'https://example.com/x/', pv: 'x', e: [{ n: '$page', t: 1, p: { section: '<img src=x onerror=alert(1)>' } }] }) }), {});
  let cookie = '';
  const get = async (path, form) => {
    const res = await app.handle(new Request(ORIGIN + path, form ? { method: 'POST', body: new URLSearchParams(form), headers: { origin: ORIGIN, cookie } } : { headers: { cookie } }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  await get('/portal/setup', { email: 'owner@example.com', password: 'correct horse battery' });
  const overview = await (await get(`/portal/sites/${site.id}?range=7d`)).text();
  assert.match(overview, /page views/);
  assert.match(overview, /video_play/);
  assert.match(overview, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(overview, /<img src=x/);
  assert.match(await (await get(`/portal/sites/${site.id}/bots?range=30d`)).text(), /GPTBot/);
  assert.match(await (await get(`/portal/sites/${site.id}/events/video_play`)).text(), /experiment/);
  await get(`/portal/sites/${site.id}/install`, { host: 'vercel' });
  assert.match(await (await get(`/portal/sites/${site.id}/settings`)).text(), /data-site=&quot;/);
});

test('reports can be filtered by consent state, and the install check reads how IDs were kept', async () => {
  const { app, site } = await seeded();
  const queries = app.portal.queries;
  // A visitor from Germany: consent required, not decided yet.
  await app.handle(new Request('https://example.com/tb/e', { method: 'POST', headers: { 'user-agent': CHROME }, body: JSON.stringify({ v: 1, s: site.id, u: 'https://example.com/de/', pv: 'd1', e: [{ n: 'page_view', t: 1, p: {} }] }) }), { ip: '4.4.4.4', country: 'DE' });
  const all = await queries.overview(site.id, Date.now() - DAY, Date.now() + DAY);
  assert.deepEqual(Object.fromEntries(all.consent.map(r => [r.key, r.value])), { not_required: 4, pending: 1 });
  assert.equal(all.totals.stableVisitors, 3, 'the pending visitor is only known for the day');
  const pending = await queries.overview(site.id, Date.now() - DAY, Date.now() + DAY, { consent: 'pending' });
  assert.deepEqual([pending.totals.pageViews, pending.pages[0].key], [1, '/de/']);
  assert.deepEqual(await queries.installCheck(site.id, Date.now() - DAY, Date.now() + DAY), { collector: 3 });
});
