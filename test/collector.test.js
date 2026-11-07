import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, memoryStorage, newSiteId, sqlStorage } from '../collector/index.js';
import { classifyBot } from '../collector/bots.js';
import { classifyReferrer, campaign, parseUserAgent } from '../collector/enrich.js';
import { cloudflareContext, d1Driver } from '../collector/cloudflare.js';
import { serve, sqliteStorage } from '../collector/node.js';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const batch = (events, extra = {}) => ({
  v: 1, u: 'https://example.com/pricing/?utm_source=news&utm_medium=email&q=shoes', l: 'en-US',
  sw: 390, sh: 844, vw: 390, vh: 664, tz: 'America/Montevideo', pv: 'pv1', tx: 'b', s: 'site1', e: events, ...extra,
});
const post = (body, headers = {}) => new Request('https://example.com/tb/e', {
  method: 'POST',
  headers: { 'content-type': 'text/plain', 'user-agent': CHROME_MAC, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const SITES = [{ id: 'site1', origins: ['https://example.com'] }];
const setup = (options = {}) => {
  const storage = memoryStorage();
  let clock = 1_762_531_200_000;
  const collector = createCollector({ storage, sites: SITES, now: () => clock, ...options });
  return { collector, records: storage.records, advance: ms => { clock += ms; } };
};

test('stores an enriched page view, plus the search derived from its URL', async () => {
  const { collector, records } = setup();
  const res = await collector.handle(post(batch([{ n: 'page_view', t: 1, p: { title: 'Pricing', ref: 'https://chatgpt.com/' } }])), { ip: '203.0.113.9', country: 'UY' });
  assert.equal(res.status, 204);
  assert.equal(records.length, 2);
  const [view, search] = records;
  assert.equal(view.name, 'page_view');
  assert.equal(view.site, 'site1');
  assert.equal(view.kind, 'event');
  assert.equal(view.source, 'script');
  assert.equal(view.js, 'on');
  assert.equal(view.pv, 'pv1');
  assert.equal(view.path, '/pricing/');
  assert.equal(view.title, 'Pricing');
  assert.equal(view.referrer_host, 'chatgpt.com');
  assert.equal(view.referrer_type, 'email', 'utm_medium=email wins over the referrer');
  assert.equal(view.utm_source, 'news');
  assert.equal(view.browser, 'Chrome');
  assert.equal(view.os, 'macOS');
  assert.equal(view.device, 'desktop');
  assert.equal(view.country, 'UY');
  assert.equal(view.traffic, 'human');
  assert.equal(view.screen_w, 390);
  assert.match(view.aid, /^[0-9a-f]{32}$/);
  assert.ok(view.sid);
  assert.equal(JSON.stringify(view).includes('203.0.113.9'), false, 'the IP is never stored');
  assert.deepEqual([search.name, search.props], ['search', { term: 'shoes' }]);
});

test('the anonymous ID is stable within a day and changes the next day; sessions end after 30 min', async () => {
  const { collector, records, advance } = setup();
  const send = () => collector.handle(post(batch([{ n: 'engagement', t: 1, p: { ms: 10, scroll: 0 } }])), { ip: '203.0.113.9' });
  await send();
  advance(10 * 60 * 1000);
  await send();
  advance(31 * 60 * 1000);
  await send();
  advance(24 * 60 * 60 * 1000);
  await send();
  const [a, b, c, d] = records;
  assert.equal(a.aid, b.aid);
  assert.equal(a.sid, b.sid);
  assert.equal(a.aid, c.aid);
  assert.notEqual(c.sid, b.sid, 'new session after 30 min idle');
  assert.notEqual(d.aid, a.aid, 'new day, new ID');
});

test('keeps downloads in the configured list and passes custom events through', async () => {
  const { collector, records } = setup();
  await collector.handle(post(batch([
    { n: 'download', t: 1, p: { url: 'https://example.com/files/Guide.PDF' } },
    { n: 'download', t: 2, p: { url: 'https://example.com/export.json' } },
    { n: 'signup_click', t: 3, p: { plan: 'pro' } },
    { n: 'bad name!', t: 4, p: {} },
  ])), {});
  assert.deepEqual(records.map(r => [r.name, r.props]), [
    ['download', { url: 'https://example.com/files/Guide.PDF', ext: 'pdf' }],
    ['signup_click', { plan: 'pro' }],
  ]);
});

test('stores only flat, valid properties, and keeps site properties on page views', async () => {
  const { collector, records } = setup();
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  await collector.handle(post(batch([
    { n: 'page_view', t: 1, p: { title: 'Pricing', ref: '', plan: 'pro' } },
    { n: 'video_play', t: 2, p: { video: 'intro', percent: 50, autoplay: false, nested: { a: 1 }, list: [1], nothing: null, nan: NaN, 'bad key': 1, long: 'x'.repeat(600) } },
    { n: 'many', t: 3, p: many },
  ])), {});
  const [view, search, video, crowded] = records;
  assert.deepEqual(view.props, { plan: 'pro' });
  assert.deepEqual(search.props, { plan: 'pro', term: 'shoes' });
  assert.deepEqual(Object.keys(video.props), ['video', 'percent', 'autoplay', 'long']);
  assert.equal(video.props.long.length, 500);
  assert.equal(Object.keys(crowded.props).length, 25);
});

test('stores page, session and user attributes as set records; reset starts a new session', async () => {
  const { collector, records } = setup();
  await collector.handle(post(batch([
    { n: 'engagement', t: 1, p: { ms: 5, scroll: 0 } },
    { n: '$page', t: 2, p: { page_type: 'article', bad: { x: 1 } } },
    { n: '$session', t: 3, p: { experiment: 'b', old: null } },
    { n: '$user', t: 4, p: { id: 'u_1', plan: 'pro' } },
    { n: '$reset', t: 5, p: { ignored: 1 } },
    { n: 'after_reset', t: 6, p: {} },
    { n: '$unknown', t: 7, p: {} },
  ])), { ip: '203.0.113.9' });
  assert.deepEqual(records.map(r => [r.kind, r.name, r.props, r.uid ?? null]), [
    ['event', 'engagement', { ms: 5, scroll: 0 }, null],
    ['set', '$page', { page_type: 'article' }, null],
    ['set', '$session', { experiment: 'b', old: null }, null],
    ['set', '$user', { plan: 'pro' }, 'u_1'],
    ['set', '$reset', {}, null],
    ['event', 'after_reset', {}, null],
  ]);
  assert.equal(records[1].pv, 'pv1');
  assert.equal(records[3].sid, records[0].sid);
  assert.notEqual(records[5].sid, records[0].sid, 'new session after reset');
});

test('rejects malformed, oversized and wrong-method requests', async () => {
  const { collector, records } = setup();
  assert.equal((await collector.handle(post('not json'))).status, 400);
  assert.equal((await collector.handle(post({ v: 2, u: 'https://example.com/', e: [] }))).status, 400);
  assert.equal((await collector.handle(post(batch([]), {}).clone())).status, 204);
  assert.equal((await collector.handle(post({ ...batch([]), u: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await collector.handle(post('x'.repeat(20_000)))).status, 413);
  assert.equal((await collector.handle(new Request('https://example.com/tb/e'))).status, 405);
  assert.equal((await collector.handle(new Request('https://example.com/other'))).status, 404);
  assert.equal(records.length, 0);
});

test('with sites configured, only their origins are accepted, and CORS allows them', async () => {
  const { collector, records } = setup({ sites: [{ id: 'acme', origins: ['https://example.com'] }, { id: 'other', origins: ['https://other.example'] }] });
  const ok = await collector.handle(post(batch([{ n: 'x', t: 1, p: {} }], { s: 'acme' }), { origin: 'https://example.com' }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.equal(records[0].site, 'acme');
  assert.equal((await collector.handle(post(batch([], { s: 'acme' }), { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await collector.handle(post(batch([], { s: 'other' })))).status, 403, 'page URL not in the site origins');
  assert.equal((await collector.handle(post(batch([], { s: 'nope' })))).status, 403);
  assert.equal((await collector.handle(post(batch([], { s: undefined })))).status, 403, 'a site ID is always required');
});

test('sites can come from an async registry, and are required', async () => {
  const registry = { abc123: { id: 'abc123', origins: ['https://example.com'] } };
  const { collector, records } = setup({ sites: async id => registry[id] || null });
  assert.equal((await collector.handle(post(batch([{ n: 'x', t: 1, p: {} }], { s: 'abc123' })))).status, 204);
  assert.equal((await collector.handle(post(batch([], { s: 'zzz' })))).status, 403);
  assert.equal(records[0].site, 'abc123');
  assert.throws(() => createCollector({}), /sites/);
  assert.match(newSiteId(), /^[a-z0-9]{12}$/);
});

test('marks automated browsers and bots that run the script as bot traffic', async () => {
  const { collector, records } = setup();
  await collector.handle(post(batch([{ n: 'page_view', t: 1, p: {} }], { wd: 1 })), {});
  await collector.handle(post(batch([{ n: 'page_view', t: 1, p: {} }]), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), {});
  assert.deepEqual(records.filter(r => r.name === 'page_view').map(r => [r.traffic, r.bot_category, r.automation]), [
    ['bot', 'automation', true],
    ['bot', 'search', false],
  ]);
  assert.equal(records[0].sid, null, 'bots get no sessions');
});

test('the noscript pixel records a page view with JavaScript off', async () => {
  const { collector, records } = setup();
  const res = await collector.handle(new Request('https://example.com/tb/n?s=site1', { headers: { referer: 'https://example.com/about/', 'user-agent': SAFARI_IPHONE } }), {});
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.equal(records.length, 1);
  assert.deepEqual([records[0].name, records[0].source, records[0].js, records[0].path, records[0].device, records[0].os], ['page_view', 'noscript', 'off', '/about/', 'mobile', 'iOS']);
});

test('observe: server-side page views for humans, every request for bots', async () => {
  const { collector, records } = setup();
  const html = new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const css = new Response('', { headers: { 'content-type': 'text/css' } });
  const page = (path, ua) => new Request('https://example.com' + path, { headers: { 'user-agent': ua, referer: 'https://www.google.com/' } });

  const pv = await collector.observe(page('/pricing/', CHROME_MAC), html, { site: 'site1' });
  assert.match(pv, /^[0-9a-f]{32}$/);
  assert.equal(await collector.observe(page('/app.css', CHROME_MAC), css, { site: 'site1' }), null);
  await collector.observe(page('/llms.txt', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'), new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }), { site: 'site1', verifiedBotCategory: 'AI Crawler' });
  await collector.observe(page('/', 'curl/8.7.1'), html, { site: 'site1' });
  assert.equal(await collector.observe(page('/', CHROME_MAC), html, {}), null, 'no site, nothing recorded');

  assert.deepEqual(records.map(r => [r.kind, r.source, r.name, r.js, r.path, r.referrer_type, r.bot_name, r.bot_category, r.bot_verified, r.special_file]), [
    ['event', 'server', 'page_view', 'unknown', '/pricing/', 'search', null, null, null, undefined],
    ['bot', 'server', 'request', undefined, '/llms.txt', 'search', 'GPTBot', 'ai_training', true, 'llms.txt'],
    ['bot', 'server', 'request', undefined, '/', 'search', 'curl', 'http_client', false, null],
  ]);
  assert.equal(records[0].pv, pv);
});

test('classifies bots by name and category, and leaves browsers alone', () => {
  const cases = [
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)', 'ChatGPT-User', 'ai_user_fetch'],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot', 'ai_training'],
    ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot', 'search'],
    ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'AdsBot-Google', 'ads'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'facebookexternalhit', 'social_preview'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'Meta-ExternalAgent', 'ai_training'],
    ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'AhrefsBot', 'seo_tool'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', 'HeadlessChrome', 'automation'],
    ['python-requests/2.32.3', 'python-requests', 'http_client'],
    ['SomeNewCrawler/0.1 (+https://example.org/bot)', null, 'unidentified'],
    ['', null, 'unidentified'],
  ];
  for (const [ua, name, category] of cases) {
    const bot = classifyBot(ua);
    assert.deepEqual([bot.name, bot.category], [name, category], ua);
  }
  assert.equal(classifyBot(CHROME_MAC), null);
  assert.equal(classifyBot(SAFARI_IPHONE), null);
});

test('parses browsers and devices, with Client Hints taking precedence', () => {
  assert.deepEqual(parseUserAgent(SAFARI_IPHONE), { device: 'mobile', browser: 'Safari', browser_version: '18.5', os: 'iOS', os_version: '18.5' });
  const edge = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0');
  assert.deepEqual([edge.browser, edge.browser_version, edge.os], ['Edge', '141.0', 'Windows']);
  const tablet = parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
  assert.equal(tablet.device, 'tablet');
  const hinted = parseUserAgent(CHROME_MAC, new Headers({ 'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-mobile': '?1' }));
  assert.deepEqual([hinted.os, hinted.device], ['Android', 'mobile']);
});

test('classifies where visits come from', () => {
  const page = new URL('https://example.com/');
  const type = (ref, url = page) => classifyReferrer(ref, url, campaign(url));
  assert.equal(type(''), 'direct');
  assert.equal(type('', new URL('https://example.com/?utm_source=partner')), 'referral', 'tagged links are not direct');
  assert.equal(type('https://example.com/blog/'), 'internal');
  assert.equal(type('https://www.google.com/'), 'search');
  assert.equal(type('https://gemini.google.com/app'), 'ai_assistant');
  assert.equal(type('https://chatgpt.com/'), 'ai_assistant');
  assert.equal(type('https://t.co/abc'), 'social');
  assert.equal(type('https://blog.example.org/post'), 'referral');
  assert.equal(type('https://www.google.com/', new URL('https://example.com/?gclid=abc')), 'paid');
  assert.deepEqual(campaign(new URL('https://example.com/?fbclid=xyz')).click_id_type, 'fbclid');
});

test('sqlStorage writes rows through a driver (SQLite via node:sqlite)', async () => {
  const storage = await sqliteStorage(':memory:');
  const collector = createCollector({ storage, sites: SITES });
  await collector.handle(post(batch([{ n: 'page_view', t: 1, p: { title: 'Pricing' } }, { n: 'signup_click', t: 2, p: { plan: 'pro' } }])), {});
  const rows = storage.driver.db.prepare('SELECT name, title, props, automation FROM tinybeam_events ORDER BY rowid').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { name: 'page_view', title: 'Pricing', props: '{}', automation: 0 },
    { name: 'search', title: null, props: '{"term":"shoes"}', automation: 0 },
    { name: 'signup_click', title: null, props: '{"plan":"pro"}', automation: 0 },
  ]);
});

test('the D1 driver batches inserts', async () => {
  const calls = [];
  const db = {
    exec: async sql => calls.push(['exec', sql.includes('CREATE TABLE')]),
    prepare: sql => ({ bind: (...params) => ({ sql, params }) }),
    batch: async statements => calls.push(['batch', statements.length]),
  };
  const collector = createCollector({ storage: sqlStorage(d1Driver(db)), sites: SITES });
  await collector.handle(post(batch([{ n: 'a', t: 1, p: {} }, { n: 'b', t: 2, p: {} }])), {});
  assert.deepEqual(calls, [['exec', true], ['batch', 2]]);
});

test('the Cloudflare context comes from request.cf', () => {
  const request = new Request('https://example.com/', { headers: { 'cf-connecting-ip': '198.51.100.7' } });
  Object.defineProperty(request, 'cf', { value: { country: 'AR', region: 'Buenos Aires', city: 'La Plata', verifiedBotCategory: 'Search Engine Crawler' } });
  const waited = [];
  const context = cloudflareContext(request, { waitUntil: p => waited.push(p) });
  assert.deepEqual([context.ip, context.country, context.region, context.city, context.verifiedBotCategory], ['198.51.100.7', 'AR', 'Buenos Aires', 'La Plata', 'Search Engine Crawler']);
  context.waitUntil(1);
  assert.deepEqual(waited, [1]);
});

test('the Node.js adapter serves the collector over HTTP', async () => {
  const storage = memoryStorage();
  const server = await serve(createCollector({ storage, sites: SITES }), { port: 0, host: '127.0.0.1' });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/tb/e`, { method: 'POST', body: JSON.stringify(batch([{ n: 'page_view', t: 1, p: {} }])), headers: { 'user-agent': SAFARI_IPHONE } });
    assert.equal(res.status, 204);
    assert.equal(storage.records[0].os, 'iOS');
    assert.ok(storage.records[0].aid);
  } finally {
    server.close();
  }
});
