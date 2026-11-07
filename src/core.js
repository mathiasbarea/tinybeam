// Tinybeam core: page views, engagement, outbound links, downloads and custom events, sent to a
// first-party collector. Whatever the collector can derive is not computed here: campaign parameters,
// click IDs and site search come from the page URL, which download extensions count from the link URL,
// device, browser and country from the request.
//
// The source sticks to ES2015 syntax (docs/spec.md, section 9). The browser APIs the core uses (Page
// Visibility, crypto.getRandomValues, Intl time zones) exist in every browser that parses ES2015;
// sendBeacon is the exception, so it falls back to XMLHttpRequest and reports which one it used in `tx`.
((w, d, n, loc) => {
  if (w.tinybeam) return;

  const script = d.currentScript;
  const attr = (name, fallback) => (script && script.getAttribute('data-' + name)) || fallback;
  // Every site has an ID (data-site), self-hosted or not; the collector rejects batches without one, so
  // without it the script doesn't measure. The collector can be the site's own (default) or anywhere
  // else, such as a hosted one.
  const site = attr('site');
  if (!site) return console.warn('tinybeam: data-site is missing');
  const endpoint = attr('endpoint', '/tb/e');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let queue = [];
  let serverPv = attr('pv');
  let pv, lastUrl, maxScroll, visibleSince;

  // 128 random bits as base-36 text.
  const randomId = () => [].map.call(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(36)).join('');
  const isVisible = () => d.visibilityState === 'visible';

  // sendBeacon where it exists (every browser since 2018), XMLHttpRequest otherwise.
  const flush = () => {
    if (!queue.length) return;
    const body = tx => JSON.stringify({
      v: 1, s: site, u: loc.href, l: n.language, sw: screen.width, sh: screen.height, vw: w.innerWidth, vh: w.innerHeight,
      tz, pv, tx, wd: n.webdriver ? 1 : undefined, e: queue,
    });
    if (!(n.sendBeacon && n.sendBeacon(endpoint, body('b')))) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.setRequestHeader('Content-Type', 'text/plain');
      xhr.send(body('x'));
    }
    queue = [];
  };
  const push = (name, props) => {
    queue.push({ n: name, t: Date.now(), p: props });
    if (queue.length > 19) flush();
  };

  const trackScroll = () => {
    const height = d.documentElement.scrollHeight;
    const seen = height > w.innerHeight ? (w.pageYOffset + w.innerHeight) / height * 100 : 100;
    const depth = Math.min(100, Math.floor((seen + 1) / 25) * 25);
    if (depth > maxScroll) maxScroll = depth;
  };
  // Visible time since the last engagement event (or since the page became visible again).
  const engage = () => {
    const ms = visibleSince ? Date.now() - visibleSince : 0;
    visibleSince = isVisible() ? Date.now() : 0;
    if (ms > 0) push('engagement', { ms, scroll: maxScroll });
  };

  const pageView = ref => {
    pv = serverPv || randomId();
    serverPv = 0;
    lastUrl = loc.href;
    maxScroll = 0;
    visibleSince = isVisible() ? Date.now() : 0;
    push('page_view', ref ? { title: d.title, ref } : { title: d.title });
    trackScroll();
    flush();
  };

  const clicked = e => {
    let tagged, linked;
    for (let el = e.target; el && el.getAttribute; el = el.parentNode) {
      const name = !tagged && el.getAttribute('data-tb-event');
      if (name) {
        tagged = 1;
        const props = {};
        for (let i = 0; i < el.attributes.length; i++) {
          const a = el.attributes[i];
          if (!a.name.indexOf('data-tb-prop-')) props[a.name.slice(13)] = a.value;
        }
        push(name, props);
      }
      if (!linked && el.tagName === 'A' && !el.protocol.indexOf('http')) {
        linked = 1;
        // Any file extension other than a web page is a download candidate; the collector keeps the
        // extensions it is configured to count.
        if (/\.(?!html?$|php$|aspx?$)\w+$/i.test(el.pathname) || el.hasAttribute('download')) push('download', { url: el.href });
        else if (el.hostname !== loc.hostname) push('outbound', { url: el.href });
      }
    }
    // The click may leave the page; send now rather than wait for pagehide.
    flush();
  };

  const hidden = () => {
    engage();
    flush();
  };
  const listen = (target, type, fn, options) => target.addEventListener(type, fn, options);
  const start = () => {
    pageView(d.referrer);
    listen(w, 'scroll', trackScroll, { passive: true });
    listen(d, 'click', clicked, true);
    listen(d, 'auxclick', clicked, true);
    listen(d, 'visibilitychange', () => (isVisible() ? (visibleSince = Date.now()) : hidden()));
    listen(w, 'pagehide', hidden);
    // Restored from the back/forward cache: a new page view for the visitor.
    listen(w, 'pageshow', e => e.persisted && pageView());
    // Single-page apps: History API navigations are page views too (a change of hash alone is not).
    const navigated = () => {
      if (loc.href.split('#')[0] !== lastUrl.split('#')[0]) {
        engage();
        flush();
        pageView(lastUrl);
      }
    };
    ['pushState', 'replaceState'].forEach(method => {
      const original = history[method];
      history[method] = function () {
        const result = original.apply(this, arguments);
        navigated();
        return result;
      };
    });
    listen(w, 'popstate', navigated);
  };

  w.tinybeam = { track: (name, props) => push(name, props || {}), flush };

  // Starts as soon as the script runs: the beacon is a small, low-priority request that doesn't hold up
  // the page, and waiting for `load` would lose visitors who leave a slow page early. A prerendered page
  // (speculation rules) counts only once the visitor actually opens it.
  if (d.prerendering) listen(d, 'prerenderingchange', start);
  else start();
})(window, document, navigator, location);
