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
  const base = endpoint.replace(/\/e$/, '');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Where the stable ID is kept (docs/spec.md, section 5): by the collector in its own cookies, or, in the
  // tinybeam-ids.js bundle (build flag IDS), by an endpoint on the site's server (data-id="endpoint") or
  // by this script (data-id="script"); then the script reads the cookies and sends the ID and the decision
  // with each batch. Every IDS-only expression starts with `IDS &&`, so the core bundle drops it.
  const idMode = attr('id');
  const ownIds = IDS && (idMode == 'endpoint' || idMode == 'script');

  let queue = [];
  let serverPv = attr('pv');
  let pv, lastUrl, maxScroll, visibleSince;

  // 128 random bits as base-36 text.
  const randomId = () => [].map.call(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(36)).join('');
  const isVisible = () => d.visibilityState === 'visible';
  const cookie = name => (d.cookie.match('(?:^|; )' + name + '=([^;]*)') || [])[1];
  const ids = () => IDS && ownIds && { i: cookie('tb_id'), c: cookie('tb_c'), is: idMode[0] };
  // A request whose answer matters (consent, the ID endpoint); `done` gets the parsed JSON.
  const request = (method, url, data, done) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.onload = () => {
      try { done && done(JSON.parse(xhr.responseText)); } catch (e) { /* not JSON: nothing to do */ }
    };
    xhr.send(data && JSON.stringify(data));
  };

  // sendBeacon where it exists (every browser since 2018), XMLHttpRequest otherwise.
  const flush = () => {
    if (!queue.length) return;
    const body = tx => Object.assign({
      v: 1, s: site, u: loc.href, l: n.language, sw: screen.width, sh: screen.height, vw: w.innerWidth, vh: w.innerHeight,
      tz, pv, tx, wd: n.webdriver ? 1 : undefined, e: queue,
    }, ids());
    if (!(n.sendBeacon && n.sendBeacon(endpoint, JSON.stringify(body('b'))))) request('POST', endpoint, body('x'));
    queue = [];
  };

  // Tinybeam's consent banner, from the collector, in the page's language (or the browser's). The
  // collector decides whether this visitor must be asked (and answers with nothing otherwise), unless
  // `force` (a "privacy settings" click).
  const banner = force => {
    const s = d.createElement('script');
    s.src = base + '/banner.js?s=' + site + '&l=' + (d.documentElement.lang || '') + ',' + n.language + (force ? '&f=1' : '') + (IDS && ownIds ? '&m=' + idMode[0] : '');
    d.head.appendChild(s);
  };
  // consent(true | false | { analytics, ads }): the visitor's decision, kept as two digits ("10": analytics
  // granted, ads refused) and recorded by the collector, which also sets its cookies in collector mode.
  let decision, source;
  const recordConsent = () => decision && request('POST', base + '/c', Object.assign({ s: site, u: loc.href, src: source }, ids(), { c: decision }));
  // In script and endpoint mode, the ID: kept or created when analytics is granted or no decision is
  // needed (a region where consent isn't required), deleted when refused.
  const setCookie = IDS && ((name, value, days) => {
    d.cookie = name + '=' + value + ';path=/;max-age=' + days * 864e2 + ';samesite=lax' + (loc.protocol == 'https:' ? ';secure' : '');
  });
  const keepId = IDS && (() => {
    const allowed = !decision || decision[0] == '1';
    if (idMode == 'script') {
      if (decision) setCookie('tb_c', decision, 182);
      setCookie('tb_id', allowed ? cookie('tb_id') || randomId() : '', allowed ? 395 : 0);
      recordConsent();
    } else request('POST', '/tb/id', decision ? { analytics: allowed, ads: decision[1] == '1' } : {}, recordConsent);
  });
  const consent = choice => {
    flush();
    const both = choice === !!choice;
    decision = '' + +(both ? choice : !!choice.analytics) + +(both ? choice : !!choice.ads);
    source = choice.source || 'api';
    if (IDS && ownIds) keepId();
    else recordConsent();
  };
  const push = (name, props) => {
    queue.push({ n: name, t: Date.now(), p: props || {} });
    if (queue.length > 19) flush();
  };
  // Page, session and user attributes go to the collector as $page / $session / $user records, which it
  // applies to the whole page view, session or user, including events sent before. Page attributes wait
  // for the next send; session and user ones (and reset) are sent at once, since later pages rely on them.
  const setter = (name, now) => props => {
    push(name, props);
    if (now) flush();
  };
  // Attributes named `${prefix}<key>` on an element, as { key: value }.
  const prefixed = (el, prefix) => {
    const out = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (!a.name.indexOf(prefix)) out[a.name.slice(prefix.length)] = a.value;
    }
    return out;
  };
  // Page attributes declared on the script tag (data-page-<key>), for the first page view.
  let scriptPage = script && prefixed(script, 'data-page-');

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
    for (const key in scriptPage) {
      push('$page', scriptPage);
      break;
    }
    scriptPage = 0;
    trackScroll();
    flush();
  };

  const clicked = e => {
    let tagged, linked;
    for (let el = e.target; el && el.getAttribute; el = el.parentNode) {
      const name = !tagged && el.getAttribute('data-tb-event');
      if (name) {
        tagged = 1;
        push(name, prefixed(el, 'data-tb-prop-'));
      }
      // A "privacy settings" element opens the consent banner again.
      if (el.hasAttribute('data-tb-consent')) banner(1);
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
    // Consent: data-consent is "auto" when the site uses Tinybeam's banner (the collector decides whether
    // to ask, while the visitor has no decision yet), or the visitor's state when a collector in front of
    // the site filled it in ("pending": ask). With the ID kept by the site or the script, the collector
    // also says when no consent is needed, so the ID can be created.
    const state = attr('consent');
    if (IDS && ownIds) {
      if (!cookie('tb_c') && !cookie('tb_id')) {
        request('GET', base + '/c?s=' + site + '&u=' + encodeURIComponent(loc.href) + '&m=' + idMode[0], 0, r => {
          if (r.c == 'pending' && state) banner();
          if (r.c == 'not_required') keepId();
        });
      }
      // The endpoint renews its cookies once a day (tb_r marks that it did today).
      if (idMode == 'endpoint' && cookie('tb_id') && !cookie('tb_r')) request('GET', '/tb/id');
    } else if (state == 'auto' ? !cookie('tb_c') : state == 'pending') banner();
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

  // track(name, props): an event and its attributes. setPage / setSession / setUser(props): attributes
  // for the whole page view, session or user, without sending an event; null removes one, and `id` in
  // setUser is the user's ID. reset(): after a sign-out, forget the user and start a new session.
  w.tinybeam = {
    track: push,
    setPage: setter('$page'),
    setSession: setter('$session', 1),
    setUser: setter('$user', 1),
    reset: setter('$reset', 1),
    consent,
    flush,
  };

  // Starts as soon as the script runs: the beacon is a small, low-priority request that doesn't hold up
  // the page, and waiting for `load` would lose visitors who leave a slow page early. A prerendered page
  // (speculation rules) counts only once the visitor actually opens it.
  if (d.prerendering) listen(d, 'prerenderingchange', start);
  else start();
})(window, document, navigator, location);
