// Runs the built bundles inside jsdom, as a real <script> element, and checks what they send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { BUNDLES, bundle, brotliSize } from '../build.mjs';

const code = Object.fromEntries(await Promise.all(BUNDLES.map(async b => [b.name, await bundle(b.flags)])));

// Loads a page and runs a bundle in it. Returns the window, the decoded payloads sent so far (live array),
// a clock to move time, and a setter for document.visibilityState.
async function load({
  name = 'tinybeam.js',
  url = 'https://example.com/pricing/?utm_source=news',
  referrer = 'https://chatgpt.com/',
  body = '',
  attrs = { 'data-site': 'site1', 'data-pv': 'server-pv' },
  beacon = true,
  setup = () => {},
} = {}) {
  const sent = [];
  const clock = { now: 1_000_000 };
  let visibility = 'visible';
  const dom = new JSDOM(`<!doctype html><title>Pricing</title><body>${body}</body>`, {
    url,
    referrer: referrer || undefined,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.Date.now = () => clock.now;
      Object.defineProperty(window.document, 'visibilityState', { get: () => visibility, configurable: true });
      if (beacon) {
        window.navigator.sendBeacon = (endpoint, data) => {
          sent.push({ endpoint, ...JSON.parse(data) });
          return true;
        };
      }
      window.XMLHttpRequest = class {
        open(method, endpoint) { this.endpoint = endpoint; }
        setRequestHeader() {}
        send(data) { sent.push({ endpoint: this.endpoint, ...JSON.parse(data) }); }
      };
      setup(window);
    },
  });
  const { window } = dom;
  if (window.document.readyState !== 'complete') await new Promise(r => window.addEventListener('load', r));
  const script = window.document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  script.textContent = code[name];
  window.document.head.appendChild(script);
  const setVisibility = state => {
    visibility = state;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
  };
  return { window, sent, clock, setVisibility };
}

const events = sent => sent.flatMap(batch => batch.e.map(e => ({ ...e, pv: batch.pv })));
// Clicks without following the link (jsdom can't navigate).
const click = (window, selector) => {
  const el = window.document.querySelector(selector);
  el.addEventListener('click', e => e.preventDefault(), { once: true });
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

test('sends a page view with the envelope as soon as the loaded page runs it', async () => {
  const { sent } = await load();
  assert.equal(sent.length, 1);
  const [batch] = sent;
  assert.equal(batch.endpoint, '/tb/e');
  assert.equal(batch.v, 1);
  assert.equal(batch.s, 'site1');
  assert.equal(batch.u, 'https://example.com/pricing/?utm_source=news');
  assert.equal(batch.pv, 'server-pv');
  assert.equal(batch.tx, 'b');
  assert.equal(typeof batch.tz, 'string');
  for (const key of ['sw', 'sh', 'vw', 'vh']) assert.equal(typeof batch[key], 'number', key);
  assert.equal(batch.wd, undefined);
  assert.deepEqual(batch.e, [{ n: 'page_view', t: 1_000_000, p: { title: 'Pricing', ref: 'https://chatgpt.com/' } }]);
});

test('uses a configured endpoint and generates a page view ID when the server gives none', async () => {
  const { sent } = await load({ attrs: { 'data-site': 'site1', 'data-endpoint': '/collect' }, referrer: '' });
  assert.equal(sent[0].endpoint, '/collect');
  assert.match(sent[0].pv, /^[0-9a-z]{16,28}$/);
  assert.deepEqual(sent[0].e[0].p, { title: 'Pricing' });
});

test('can send to a collector elsewhere, naming the site', async () => {
  const { sent } = await load({ attrs: { 'data-endpoint': 'https://collect.example.net/tb/e', 'data-site': 'acme' } });
  assert.equal(sent[0].endpoint, 'https://collect.example.net/tb/e');
  assert.equal(sent[0].s, 'acme');
});

test('sends visible time and scroll depth when the page is hidden, and none twice', async () => {
  const { window, sent, clock, setVisibility } = await load({
    setup(window) {
      Object.defineProperty(window.HTMLHtmlElement.prototype, 'scrollHeight', { value: 4000, configurable: true });
    },
  });
  clock.now += 5000;
  Object.defineProperty(window, 'pageYOffset', { value: 2232, configurable: true }); // (2232 + 768) / 4000 = 75%
  window.dispatchEvent(new window.Event('scroll'));
  setVisibility('hidden');
  clock.now += 60_000; // hidden time doesn't count
  setVisibility('visible');
  clock.now += 2000;
  setVisibility('hidden');
  window.dispatchEvent(new window.Event('pagehide')); // right after hidden: nothing new to send
  const engagement = events(sent).filter(e => e.n === 'engagement');
  assert.deepEqual(engagement.map(e => e.p), [{ ms: 5000, scroll: 75 }, { ms: 2000, scroll: 75 }]);
});

test('a page shorter than the viewport counts as fully scrolled', async () => {
  const { sent, clock, setVisibility } = await load();
  clock.now += 1000;
  setVisibility('hidden');
  assert.deepEqual(events(sent).find(e => e.n === 'engagement').p, { ms: 1000, scroll: 100 });
});

test('tracks outbound links, downloads and tagged elements, and sends right away', async () => {
  const { window, sent } = await load({
    body: `
      <a id="out" href="https://other.example/page">out</a>
      <a id="pdf" href="/files/brochure.PDF">pdf</a>
      <a id="attr" href="/export?id=3" download>attr</a>
      <a id="page" href="/about.html">same-site page</a>
      <a id="mail" href="mailto:hi@example.com">mail</a>
      <a id="cta" href="https://other.example/signup" data-tb-event="signup_click" data-tb-prop-plan="pro"><span id="inner">go</span></a>`,
  });
  for (const id of ['out', 'pdf', 'attr', 'page', 'mail', 'inner']) click(window, '#' + id);
  const tracked = events(sent).filter(e => e.n !== 'page_view').map(e => [e.n, e.p]);
  assert.deepEqual(tracked, [
    ['outbound', { url: 'https://other.example/page' }],
    ['download', { url: 'https://example.com/files/brochure.PDF' }],
    ['download', { url: 'https://example.com/export?id=3' }],
    ['signup_click', { plan: 'pro' }],
    ['outbound', { url: 'https://other.example/signup' }],
  ]);
  assert.equal(sent.length, 5, 'page view + one batch per tracked click');
});

test('tinybeam.track queues custom events and flushes them in batches of 20', async () => {
  const { window, sent } = await load();
  window.tinybeam.track('a', { x: 1 });
  assert.equal(sent.length, 1);
  window.tinybeam.flush();
  assert.deepEqual(sent[1].e.map(e => [e.n, e.p]), [['a', { x: 1 }]]);
  for (let i = 0; i < 20; i++) window.tinybeam.track('b');
  assert.equal(sent.length, 3);
  assert.equal(sent[2].e.length, 20);
});

test('setPage waits for the next send; setSession, setUser and reset send at once', async () => {
  const { window, sent } = await load();
  window.tinybeam.setPage({ page_type: 'article' });
  assert.equal(sent.length, 1, 'page attributes wait');
  window.tinybeam.track('a', { x: 1 });
  window.tinybeam.setSession({ experiment: 'pricing-b' });
  assert.deepEqual(sent[1].e.map(e => [e.n, e.p]), [['$page', { page_type: 'article' }], ['a', { x: 1 }], ['$session', { experiment: 'pricing-b' }]]);
  window.tinybeam.setUser({ id: 'u_1', plan: null });
  assert.deepEqual(sent[2].e.map(e => [e.n, e.p]), [['$user', { id: 'u_1', plan: null }]]);
  window.tinybeam.reset();
  assert.deepEqual(sent[3].e.map(e => e.n), ['$reset']);
  assert.equal(sent[3].pv, sent[0].pv, 'attributes are tied to the page view they were set on');
});

test('page attributes on the script tag go with the first page view', async () => {
  const { window, sent, clock } = await load({ attrs: { 'data-site': 'site1', 'data-page-page_type': 'article', 'data-page-author': 'mathias' } });
  assert.deepEqual(sent[0].e.map(e => [e.n, e.p]), [['page_view', { title: 'Pricing', ref: 'https://chatgpt.com/' }], ['$page', { page_type: 'article', author: 'mathias' }]]);
  clock.now += 1000;
  window.history.pushState({}, '', '/next/');
  assert.equal(events(sent).filter(e => e.n === '$page').length, 1, 'not repeated on later page views');
});

test('falls back to XMLHttpRequest without sendBeacon and says so', async () => {
  const { sent } = await load({ beacon: false });
  assert.equal(sent[0].tx, 'x');
  assert.equal(sent[0].e[0].n, 'page_view');
});

test('flags automated browsers', async () => {
  const { sent } = await load({
    setup(window) { Object.defineProperty(window.navigator, 'webdriver', { value: true, configurable: true }); },
  });
  assert.equal(sent[0].wd, 1);
});

test('a prerendered page counts only once it is shown', async () => {
  let prerendering = true;
  const { window, sent } = await load({
    setup(window) { Object.defineProperty(window.document, 'prerendering', { get: () => prerendering, configurable: true }); },
  });
  assert.equal(sent.length, 0);
  prerendering = false;
  window.document.dispatchEvent(new window.Event('prerenderingchange'));
  assert.equal(events(sent)[0].n, 'page_view');
});

test('a page restored from the back/forward cache is a new page view', async () => {
  const { window, sent } = await load();
  const restored = new window.Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  const views = events(sent).filter(e => e.n === 'page_view');
  assert.equal(views.length, 2);
  assert.notEqual(views[1].pv, views[0].pv);
});

test('without data-site it measures nothing and says why', async () => {
  const warnings = [];
  const { window, sent } = await load({ attrs: {}, setup(window) { window.console.warn = m => warnings.push(m); } });
  assert.equal(sent.length, 0);
  assert.equal(window.tinybeam, undefined);
  assert.deepEqual(warnings, ['tinybeam: data-site is missing']);
});

test('loading the script twice measures once', async () => {
  const { window, sent } = await load();
  const again = window.document.createElement('script');
  again.setAttribute('data-site', 'site1');
  again.textContent = code['tinybeam.js'];
  window.document.head.appendChild(again);
  assert.equal(sent.length, 1);
});

test('History API navigations are page views', async () => {
  const { window, sent, clock } = await load();
  clock.now += 3000;
  window.history.pushState({}, '', '/docs/');
  window.history.replaceState({}, '', '/docs/#install'); // hash only: same page
  window.dispatchEvent(new window.Event('popstate'));
  const all = events(sent);
  assert.deepEqual(all.map(e => e.n), ['page_view', 'engagement', 'page_view']);
  assert.equal(all[1].pv, all[0].pv, 'engagement belongs to the page it measured');
  assert.equal(all[1].p.ms, 3000);
  assert.notEqual(all[2].pv, all[0].pv);
  assert.deepEqual(all[2].p, { title: 'Pricing', ref: 'https://example.com/pricing/?utm_source=news' });
  assert.equal(sent.at(-1).u, 'https://example.com/docs/');
});

test('bundles parse as ES2015 and fit their size budgets', () => {
  for (const { name, budget } of BUNDLES) {
    assert.doesNotThrow(() => parse(code[name], { ecmaVersion: 2015 }), name);
    const size = brotliSize(code[name]);
    assert.ok(size <= budget, `${name}: ${size} B brotli, budget ${budget} B`);
  }
});
