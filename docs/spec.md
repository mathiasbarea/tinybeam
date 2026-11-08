# Tinybeam spec (draft)

Status: **draft.** Implemented so far: the core script, the collector, consent (section 5) and the portal's first
pages; names and fields may change until the first release.
Decisions taken during review are listed at the end.

## 1. Scope

This document defines:

- the events the browser script sends and their fields,
- how every measurement records whether the browser could take it (capabilities and coverage),
- the identity model (anonymous ID, session, user ID) and how it maps to destinations,
- consent: what it's asked for, by region, and how each event records it,
- the wire format between the script and the collector,
- what the collector adds on its own: enrichment, visits without JavaScript, and bot traffic.

A rule that applies throughout: **a missing value is never silent.** Anything that could not be measured
says why (not instrumented, not supported by the browser, or supported but no value), so every number can
be reported together with the base it comes from.

## 2. Loading

```html
<script src="/tb/tinybeam.js" data-site="SITE_ID" data-pv defer></script>
```

- One file per site: the modules the site uses are selected at build time and bundled with the core.
  Available today: the core (`tinybeam.js`), which includes SPA navigation and consent, and
  `tinybeam-ids.js`, the core plus keeping the stable ID through the site's endpoint or in cookies the
  script writes (section 5), for sites whose collector is on another domain.
- Served from the site's own origin with long-lived, immutable caching (hashed file name in builds).
- Starts as soon as it runs (with `defer`, right after the HTML is parsed) and sends the `page_view` then.
  The beacon is a small, low-priority request that doesn't delay rendering, and waiting for the `load`
  event would lose visitors who leave a slow page early. A prerendered page (speculation rules) waits until
  the visitor actually opens it.
- Configuration comes from `data-*` attributes on the script tag:
  - `data-endpoint`: collector path (default `/tb/e`),
  - `data-site`: **required**, the site's ID (sent as `s`). Without it the script doesn't measure and logs a
    warning,
  - `data-pv`: left empty in the page; a collector in front of the site fills in the page view ID it
    assigned (section 7). Empty means the script generates one,
  - `data-page-<key>`: page attributes for the first page view (see Attributes, section 3),
  - `data-consent`: `auto` when the site uses Tinybeam's consent banner; a collector in front of the site
    replaces it with the visitor's consent state (section 5).
- Neutral paths (`/tb/`) are recommended; names such as `analytics.js` are commonly blocked by filter lists.
- Page API:
  - `tinybeam.track(name, props)` queues a custom event with its attributes,
  - `tinybeam.setPage(props)`, `tinybeam.setSession(props)`, `tinybeam.setUser(props)` set attributes for
    the whole page view, session or user, without sending an event (see Attributes, section 3),
  - `tinybeam.reset()` forgets the user and starts a new session, for sign-outs,
  - `tinybeam.consent(true | false | { analytics, ads })` records the visitor's consent decision (section 5),
  - `tinybeam.flush()` sends the queue now.

## 3. Events

Every event shares an envelope (section 6). Event-specific fields go in `p` (properties).

### Core

| Event | When | Properties |
| --- | --- | --- |
| `page_view` | Page load, restore from the back/forward cache, and History API navigations | `title`, `ref` (referrer, when there is one) |
| `engagement` | When the page is hidden, and before an SPA navigation; not sent when no visible time passed | `ms` (visible time since the last `engagement`), `scroll` (max depth reached: 0, 25, 50, 75, 100) |
| `outbound` | Click (or middle click) on a link to another host | `url` |
| `download` | Click on a link with a `download` attribute or whose path ends in a file extension other than a web page (`.html`, `.htm`, `.php`, `.asp`, `.aspx`) | `url` |
| custom | `tinybeam.track(name, props)` or click on an element with `data-tb-event` | the site's own, see below |

`data-tb-event="signup_click"` on an element sends that event on click; `data-tb-prop-<key>="value"`
attributes become its properties. Clicks are sent right away, since they may leave the page.

Properties, on any event: a flat object of strings, finite numbers and booleans; keys of letters, digits
and underscores, up to 40 characters; up to 25 per event; strings cut at 500 characters. The collector drops
anything else (nested objects, arrays, `null`), so a page can't fill the database with arbitrary data.

### Attributes

Four scopes, each with its own call:

| Scope | Call | Applies to | Example |
| --- | --- | --- | --- |
| Event | `track(name, props)` | That event | `video_play` with `percent: 50` |
| Page | `setPage(props)`, or `data-page-<key>` on the script tag | **Every** event of that page view, including those sent before the call | `page_type`, `author`, `logged_in` |
| Session | `setSession(props)` | **Every** event of that session, including those sent before the call | `experiment`, `promo` |
| User | `setUser(props)`; `id` is the site's user ID | Every event of that user, across sessions | `plan`, `customer_type` |

- `null` removes an attribute. The same limits as event properties apply.
- The calls don't send an event. They queue a record (`$page`, `$session`, `$user`) that the collector stores
  as `kind: "set"`, tied to its page view (`pv`), session (`sid`) or user (`uid`). Values are applied when
  querying, so a page or session attribute also covers events sent before it was set. Within a scope the
  latest value of each key wins.
- Sending: `setPage` waits for the next send (a click, navigation, hiding the page, 20 queued events, or
  `flush()`), since it only matters for that page and is lost only if the page's other events are too.
  `setSession`, `setUser` and `reset` are sent at once, since later pages and destinations rely on them.
  To make sure an attribute arrives with an action, set it and then `track` the action.
- Precedence when the same key is set at several scopes: event, then page, then session, then user.
- User attributes need a stable identity across sessions: the site's user ID (`id`), or the stable
  anonymous ID (consent `granted` or `not_required`, section 5). Without either, a user is only recognized
  within one day (the daily hash's lifetime), and reports say so.
- `reset()` (for sign-outs, on shared devices): sends `$reset`; the collector ends the session, so what
  follows starts a new one without the previous session's attributes and without the user. With a stable
  anonymous ID it also gets a new one. It deletes nothing already recorded. Page attributes stay, since
  the page is the same.
- Destinations receive the resolved attributes (section 8).

Derived by the collector from the page URL `u` and the event URLs, so the script doesn't carry that code:

| Event or field | From |
| --- | --- |
| `utm_*` and click IDs (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`) on the `page_view` | `u` |
| `search` event with `term` | `u`, when it has a configured search parameter (`q`, `s`, `query`) |
| `download.ext`, and dropping downloads whose extension isn't in the configured list | `download.url` |

### Module: sections

Elements marked with `data-tb-section="pricing"` (or `data-tb-component`) are observed with
`IntersectionObserver`. An element counts as seen when at least 50% of it (or 50% of the viewport, for
tall elements) is visible for at least 1 s.

| Event | Properties |
| --- | --- |
| `section_view` | `id`, `kind` (`section` or `component`), `ms` (total visible time on this page view), `order` (1 = first section seen) |

Sent once per section per page view, batched with the page's final `engagement`.

### Module: vitals

| Event | Properties |
| --- | --- |
| `vitals` | `lcp`, `inp`, `cls`, `ttfb`, `fcp` (ms, except `cls`), `nav` (`navigate`, `reload`, `back_forward`, `prerender`) |

One event per page view, sent when the page is hidden. Measured with `PerformanceObserver`, following the
definitions used by the Chrome UX Report. A metric the browser doesn't support is omitted and flagged in
`cap` (below); a supported metric without a value (for example INP when the visitor never interacted, or
LCP when the page was hidden before it painted) is sent as `null`.

### Capabilities and coverage

Each batch carries `cap`: one key per browser feature that an included module relies on, with `1`
(available) or `0` (missing). Modules that are not in the site's bundle add no keys.

| Key | Feature | Used for |
| --- | --- | --- |
| `io` | `IntersectionObserver` | `section_view` |
| `lcp`, `cls`, `inp`, `fcp`, `ttfb` | `PerformanceObserver` entry types (`largest-contentful-paint`, `layout-shift`, `event` with `interactionId`, `paint`, `navigation`) | The matching `vitals` metric |

The core adds no `cap` keys: the APIs it relies on (Page Visibility, `crypto.getRandomValues`, `Intl` time
zones) exist in every browser that can parse the script, so a browser that runs the core has all of them.
The one exception is `navigator.sendBeacon`, which has a fallback; the envelope carries `tx`, the
transport that delivered the batch (`b` beacon, `x` XMLHttpRequest).

So every measurement ends up in exactly one of these states, and the collector keeps them apart:

| State | How it shows | Example |
| --- | --- | --- |
| Measured | A value | `inp: 180` |
| No value | Supported, value `null` | Visitor never interacted, so no INP |
| Unsupported | `cap` key is `0` | Safari has no INP |
| Not instrumented | No script data for the page view (`js` is `off` or `unknown`, section 7) or module not bundled | JavaScript disabled |

Every aggregate the collector or a dashboard reports comes with its base, for example: *"INP p75 = 210 ms,
from 6,210 page views; 1,380 excluded (browser doesn't support INP), 410 without interaction, 95 without
script data."* Queries can filter on any of these states.

## 4. Identity

| ID | Field | Lifetime | Who creates it |
| --- | --- | --- | --- |
| Anonymous ID | `aid` | Depends on the consent state and where it's kept (section 5): 13 months, 7 days, one day, or none | Collector, or the site's endpoint or the script (section 5) |
| Session ID | `sid` | Ends after 30 min without events; none when consent is `denied` | Collector |
| User ID | `uid` | Set by the site with `tinybeam.setUser({ id })`; cleared by `reset()` | Site |
| Page view ID | `pv` | One page view; ties `engagement`, `section_view` and `vitals` to their `page_view` | Script |

- The stable anonymous ID is a first-party cookie, preferably `HttpOnly`, `Secure`, `SameSite=Lax` and set
  by a server on the site's own domain, so it survives the 7-day cap that Safari applies to cookies written
  by JavaScript (section 5 lists the three ways and what each costs).
- `setUser({ id })` links the anonymous ID and session to the user ID in the collector. Earlier events stay
  attached to the anonymous ID; destinations that support it receive both.
- Format: 128-bit random values as URL-safe text (the script uses base 36), no embedded meaning.

### Mapping to destinations

| Destination | Tinybeam → destination |
| --- | --- |
| GA4 Measurement Protocol | `aid` → `client_id`, `uid` → `user_id`, `sid` → `session_id`, `engagement.ms` → `engagement_time_msec` |
| Meta Conversions API | `uid` (SHA-256) → `external_id`; `_fbp` / `_fbc` cookies or `fbclid` when present |
| Microsoft Clarity, Hotjar | The page passes them the same user ID it gives `setUser`, through their own `identify` (the anonymous ID is computed by the collector, so the page doesn't know it) |

## 5. Consent

What needs consent is decided by what Tinybeam does, not only by where the visitor is. Counting visits
without storing anything on the device and without forwarding them is first-party audience measurement;
two things go further and are what consent is asked for:

- `analytics`: a first-party cookie with a stable ID, to recognize a visitor on later days,
- `ads`: forwarding events to advertising platforms (GA4, Meta, Google Ads…).

> This section describes what Tinybeam can do, not legal advice. Rules differ by country and keep changing,
> and the site owner is responsible for the settings they choose. A site run by a company established in
> the EU, for example, generally has to ask every visitor, wherever they are (the "ask everyone" mode).

### Identity by consent state

The collector decides each event's consent state and records it in `consent` (for `analytics`) and
`ads_consent`:

| State | Means | Anonymous ID | Session | Forwarded to ad platforms |
| --- | --- | --- | --- | --- |
| `granted` | The visitor accepted | Stable random ID in a first-party cookie | Yes | Yes (`ads` granted) |
| `not_required` | Region where the site measures fully by default | Stable random ID in a first-party cookie | Yes | Yes, until the visitor opts out |
| `pending` | Region that requires consent, no decision yet | Daily hash, nothing stored on the device | Yes | No |
| `denied` | The visitor refused | None | None | No |
| `gpc` | The browser sent Global Privacy Control (`Sec-GPC: 1`) | As `denied` where consent is required; daily hash elsewhere | As the ID | No |

- Daily hash: `hash(daily salt, site, IP, user agent)`. The salt rotates every 24 h and is discarded; the
  IP is never stored. It recognizes a visitor within one day only.
- `denied` events are counted without any identifier: page views, pages, sources and events, but not
  visitors or sessions. A site can choose not to measure refusals at all instead (portal); then only the
  refusal itself is recorded (below).
- `ads_consent` takes the same values and only decides forwarding to advertising destinations (section 8).
  Outside regions that require consent, `ads` is `not_required` until the visitor opts out, which is also
  what US state laws (opt-out of "sale" or "sharing") expect; GPC is always honored as that opt-out.
- When a visitor accepts mid-session, the session continues (it isn't counted twice) and the stable ID
  applies from then on. Events recorded before the decision are not linked to the new ID.
- Revoking deletes the cookie; what follows is `denied`.

### Who decides the region

The browser doesn't know the visitor's country; the collector does (section 7). Each site sets in the
portal:

- **Mode:** automatic by region (default), ask everyone, or never ask. "Never ask" means either anonymous
  only (everyone `pending`, no banner) or full measurement everywhere (everyone `not_required`).
- **Regions that require consent** in automatic mode: by default the EU and EEA, the United Kingdom and
  Switzerland, editable country by country. An unknown country counts as requiring consent.
- **On refusal:** count without an identifier (default) or don't measure.

Country from the IP is approximate (VPNs, travelers); "ask everyone" avoids depending on it.

### The decision record

A decision is sent at once to the collector with `POST /tb/c` (`XMLHttpRequest`, not a beacon, so in
`collector` mode the response can set the cookies reliably; in the other modes the cookies are written as
described below). It is stored as a `kind: "set"` record named `$consent` with
`{ analytics, ads, source }` (`source`: `banner`, `api`). It carries no IP, and when the decision is a
refusal, no ID either. These records are the proof of consent that the GDPR asks a site to be able to show,
and what counts refusals when refusals aren't measured.

### Where the stable ID and the decision are kept

Two first-party cookies on the site's domain:

- `tb_c`: the decision as two digits, analytics then ads (`10`: analytics granted, ads refused), 6 months,
  so the banner doesn't come back on every page. Remembering a refusal is strictly necessary for it to be
  respected, so it needs no consent itself. It is readable by the script (not `HttpOnly`), so the script
  knows a decision exists without asking. In collector mode, `--` (1 day) marks a visitor who needs no
  decision (a region where consent isn't required); it is not a decision.
- `tb_id`: the stable anonymous ID, 13 months, renewed on each visit, only with consent (`granted` or
  `not_required`). The collector creates it from the day's hash, so the visitor's records of that day and
  the cookie's later ones are the same visitor, and a browser that drops the cookie still counts once a
  day rather than once per request.

Browsers only keep cookies for the site that set them, and Safari also caps cookies at 7 days when they are
written by JavaScript, or set by a server whose IP address doesn't match the site's (a subdomain pointing
to another provider counts as such). So where the cookies are written decides how long a returning visitor
is recognized. There are three ways, chosen per site; every event records which one it used in `id_store`
(`collector`, `endpoint`, `script`, or empty when there is no stable ID), so reports can be filtered and
compared by it:

| `id_store` | How | Needs on the site | Lifetime in Safari |
| --- | --- | --- | --- |
| `collector` (recommended) | The collector answers under the site's own domain, at a `/tb/` path (a proxy rule, a Worker, or mounted in the site's server), and sets `HttpOnly` cookies in its responses | A proxy or rewrite rule (one line in Cloudflare, Vercel, Netlify, Nginx…) | 13 months |
| `endpoint` | A small endpoint on the site's own server, `/tb/id`, keeps the cookies; the script calls it, then sends events straight to a collector on any domain | A short server file (examples for PHP/WordPress, Node.js and others) | 13 months |
| `script` | The script writes the cookies itself and sends events to a collector on any domain | Nothing | 7 days (24 h when arriving from a link with tracking parameters) |

- A collector on another domain can't set cookies for the site: its own would be third-party cookies, which
  Safari and Firefox block. That is why the last two ways send the ID and the decision in the batch (`i`
  and `c`, section 6) instead.
- A subdomain served by the same provider as the site (both behind Cloudflare, for example) keeps the 13
  months; one that points to another provider is capped. Tinybeam can't know the IP addresses involved,
  so the portal recommends a path, and the 7-day cap is verified in Safari, not assumed.

**The endpoint** answers two requests from the browser, on the same origin as the page:

- `GET /tb/id`: returns `{ "i": ID or null, "c": decision or null }` from its cookies and renews `tb_id`.
  Its cookies aren't `HttpOnly`, since the script reads them for each batch; `tb_r` (1 day) marks that the
  ID was renewed today, so the script calls GET at most once a day.
- `POST /tb/id` with `{ "analytics": bool, "ads": bool }`: stores the decision in `tb_c`; with `analytics`
  granted it creates `tb_id` (a random ID it generates itself), and with `analytics` refused it deletes it.
  With an empty body it only creates `tb_id`, for regions where consent isn't required.

The endpoint generates the ID instead of receiving it, so no link or third party can plant an ID chosen by
someone else in a visitor's browser. It needs no configuration or secrets, and it doesn't know the
visitor's region, which the collector still decides: when the script has neither an ID nor a decision, it
asks the collector (`GET /tb/c`, below), and only if consent isn't required there does it ask the endpoint
to create the ID.

**Script mode** writes `tb_id` and `tb_c` with `document.cookie` (not `HttpOnly`, so other scripts on the
page can read them). In Safari the decision expires with the ID, so the banner can come back after 7 days.

### Page API

- `tinybeam.consent(true | false)` grants or refuses both purposes; `tinybeam.consent({ analytics, ads })`
  sets them separately. For sites that already have a consent banner (a CMP): call it from the banner's
  callback, and Tinybeam shows nothing of its own. Adapters that read common CMPs (Google Consent Mode,
  IAB TCF) directly are a later module.
- An element with `data-tb-consent` opens Tinybeam's banner again when clicked (a "Privacy settings" link),
  since withdrawing must be as easy as giving consent.

### Tinybeam's banner

Optional, for sites without a CMP. It's a separate file, `/tb/banner.js`, loaded only for visitors who
must see it, so the core stays within its budget (section 9).

- The snippet carries `data-consent="auto"` when the site uses Tinybeam's banner. A collector in front of
  the site replaces it with the resolved state (`pending`, `granted`, `denied`, `not_required`, or `none`
  when there is nothing to ask), as it does with `data-pv`.
- The core loads `/tb/banner.js?s=SITE_ID&l=LANG` when the state is `pending`, or, with `auto`, while the
  visitor has no decision yet (no `tb_c` cookie). The collector decides from the visitor's cookies,
  country and Global Privacy Control: it answers with the banner and that site's texts in that language,
  or with an empty script when there is nothing to ask (plus the cookies that say so). That answer depends
  on the visitor, so it is never cached. A `data-tb-consent` click adds `&f=1` to show it anyway.
- In `endpoint` and `script` mode the collector can't see the site's cookies, so the script asks
  `GET /tb/c?s=SITE_ID&u=PAGE&m=e|s` (`{ "c": state }`) while the visitor has neither an ID nor a decision,
  to know whether to show the banner or create the ID.
- The banner asks only for what needs consent (returning-visitor cookie, advertising platforms), with
  "Accept" and "Reject" equally prominent and a link to the site's privacy policy. Its text also says that
  visits are counted anonymously and in aggregate either way, so "Reject" doesn't read as "don't count me".
- Language (`LANG`): by default the page's language (`<html lang>`), then the visitor's browser language
  (`navigator.language`), among the languages the site has texts for; otherwise the site's default
  language. The owner can instead fix one language.
- Texts: built-in translations for English, Spanish, Portuguese, French, German, Italian, Dutch and Polish.
  In the portal the owner can edit each one, add languages, set the privacy policy link per language, and
  choose the position and colors.

### Reporting

Dashboards show how many visitors and sessions are in each state, and every report can be filtered by
consent state (for example, only visitors who accepted). Two caveats are shown with those numbers:

- visitors who accepted are recognized across days and `pending` ones only within a day, so their counts
  are shown apart rather than summed without explanation,
- people who accept don't behave like everyone else, so a report on consented visitors only says what share
  of the traffic it covers.

## 6. Wire format

`POST /tb/e` with `Content-Type: text/plain` (so `navigator.sendBeacon` doesn't trigger a CORS preflight),
body as JSON, sent with `navigator.sendBeacon` or, where it doesn't exist, `XMLHttpRequest`.

The `page_view` and clicks are sent right away. Everything else is queued and sent when the page is
hidden, before an SPA navigation, when the queue reaches 20 events, or on `tinybeam.flush()`. A batch
never mixes page views: it is sent before the page view ID changes.

A batch sent when the page was hidden (with the sections and vitals modules):

```json
{
  "v": 1,
  "u": "https://example.com/pricing/?utm_source=newsletter",
  "l": "en-US",
  "sw": 390, "sh": 844, "vw": 390, "vh": 664,
  "tz": "America/Montevideo",
  "pv": "1r3xk2o0v9q4w7m1b8n5c6l2",
  "cap": { "io": 1, "lcp": 1, "cls": 1, "inp": 0, "fcp": 1, "ttfb": 1 },
  "tx": "b",
  "e": [
    { "n": "section_view", "t": 1762531212000, "p": { "id": "plans", "kind": "section", "ms": 8400, "order": 1 } },
    { "n": "vitals", "t": 1762531260000, "p": { "lcp": 820, "cls": 0, "fcp": 610, "ttfb": 95, "nav": "navigate" } },
    { "n": "engagement", "t": 1762531260000, "p": { "ms": 41200, "scroll": 75 } }
  ]
}
```

- `wd: 1` is added when `navigator.webdriver` is true (an automated browser; see bot traffic, section 7).
- `i` (the stable anonymous ID), `c` (the consent decision, two digits as in `tb_c`) and `is` (`e` endpoint,
  `s` script) are added only when the ID is kept by the site's endpoint or by the script (section 5); in
  `collector` mode the collector reads them from its own cookies. The collector still applies the visitor's region
  and Global Privacy Control, and ignores `i` when the resulting state doesn't allow a stable ID.
- Short keys keep the payload small; the collector expands them.
- `t` is the client time in ms; the collector also records its own receive time and uses it for ordering.
- The collector answers `204 No Content`. Payloads over 16 KB are rejected.

## 7. Collector

### Runtime and deployment

The collector is a library built only on web-standard APIs (`Request`, `Response`, `URL`,
`crypto.subtle`), so it is not tied to any provider:

- `createCollector(options)` returns `handle(request, context)`, which answers `POST /tb/e` (events) and
  `GET /tb/n` (noscript pixel), and `observe(request, response, context)` for a collector in front of the
  site (server-side page views and bot requests).
- `context` is what the platform knows about the client: `ip` (only used for the daily anonymous ID, never
  stored), `country`, `region`, `city`, `verifiedBotCategory`, and `waitUntil` so storage doesn't delay the
  response. Platform adapters fill it in: Node.js (`node:http`, X-Forwarded-For behind a trusted proxy) and
  Cloudflare Workers (`request.cf`). Without an adapter, country comes from common CDN headers
  (`cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country`…).
- Storage is any object with `write(records)`. Included: SQL databases through a two-method driver
  (`exec`, `run`; drivers for SQLite via `node:sqlite` and Cloudflare D1), JSON Lines files, and memory.
  Records are flat rows (one per event); the column list is `COLUMNS` in `collector/storage.js`.
- The daily salt and the sessions live in memory by default. Running several collector instances needs a
  shared salt and session store, passed as options (`salt`, `sessions`).

Ways to deploy, same code: a standalone server (behind a reverse-proxy rule for `/tb/` on the site's
domain, to stay first-party), a proxy or Worker in front of the site, mounted inside the site's own server,
or a hosted collector serving many sites.

### Sites

Every site has an ID, in every setup: one self-hosted collector for one site, one for many, or a hosted
service. Adding a site (by hand in the configuration today, from an admin UI later) means giving it a name
and its origins and getting an ID back (`newSiteId()`: 12 lowercase letters and digits). So moving between
self-hosting and a hosted collector only changes the endpoint, never the data model.

`sites` is required: a list of `{ id, name, origins }`, or `async id => site | null` for a registry kept
elsewhere. A batch must name its site (`s`), its page URL must be one of the site's origins, and so must
the `Origin` header when the browser sends one; anything else gets `403`. The noscript pixel names it as
`?s=`, and `observe` takes it as `context.site`. Responses allow those origins through CORS, so
a collector on another domain works too.

### Data retention

A site's records are kept for 24 months by default (`RETENTION_MONTHS`), and each site can set its own
period (`site.retention`, in months; the collector's `retention` option changes the default). Older records
are deleted by the collector itself, at most once a day per site, after it stores something for that site,
so no scheduled job is needed. A storage that can't delete (no `prune(site, before)`) keeps everything.
The site's privacy policy should state the same period.

### Enrichment

The collector adds, per event:

- `device` (`mobile`, `tablet`, `desktop`), `browser`, `browser_version`, `os`, `os_version`, from the user
  agent and User-Agent Client Hints when available,
- `country`, `region`, `city` from the platform or headers; the IP itself is not stored,
- `aid`, `sid` (section 4); bots get no session,
- `consent` and `ads_consent` (section 5), from the decision (cookie or `c`), the visitor's region, the
  site's settings and Global Privacy Control, and `id_store`, where the stable ID was kept,
- on page views: `referrer_type` (`direct`, `internal`, `paid`, `email`, `ai_assistant`, `search`,
  `social`, `referral`), `referrer_host`, campaign parameters and the first click ID found
  (`click_id_type`, `click_id`),
- `traffic` (`human` or `bot`) and, for bots, `bot_name`, `bot_category`, `bot_verified`.

Computed when querying, not stored: `engaged_session` (more than 10 s of visible time, two page views, or a
conversion event), `new_visitor` (stable anonymous ID only).

### Visits without JavaScript

A page view can reach the collector three ways, and each record says which ones it got:

| Source | How | Requires |
| --- | --- | --- |
| Server | The collector logs every HTML request it serves | The collector in front of the site (for example a Cloudflare Worker) |
| Noscript | `<noscript><img src="/tb/n?s=SITE_ID" alt="" width="1" height="1"></noscript>` in the page; only browsers with JavaScript off load it. The page URL comes from the `Referer` header | Nothing extra |
| Script | The browser script | JavaScript |

From those, each page view gets `js`:

- `on`: the script reported it;
- `off`: the noscript pixel loaded, so JavaScript was disabled;
- `unknown`: the server saw the request but neither the script nor the pixel reported (the visitor left
  before the script ran, the script was blocked or failed, or images were off too).

When the collector serves the HTML it adds the page view ID to the script tag (streaming, with
`HTMLRewriter` on Cloudflare), so the script's events merge into the server's record instead of counting
the visit twice. Without it, records are matched by anonymous ID, URL and time.

### Bot traffic

Every request the collector sees is classified as `human` or `bot`. Human reports exclude bots by default;
bots go to their own dataset, where they can be analyzed separately.

Seeing bots requires seeing the HTML requests themselves. Most bots download the HTML and nothing else: they
run no JavaScript and load no images, so neither the script nor the noscript pixel reaches them (the pixel
is for humans with JavaScript off). The supported ways are:

- the collector in front of the site (a Worker or reverse proxy; it can be a pass-through that only logs),
- importing the host's or CDN's request logs (for example Cloudflare Logpush) into the collector.

With the script alone, only bots that execute JavaScript are seen (and flagged, see the signals below).

**Classification**, in order:

1. **Known bots** by user agent, from a maintained list (data, not code): name and category.
2. **Verification**, where possible: the platform's verified-bot signal (for example Cloudflare's
   `request.cf.verifiedBotCategory`) or the IP ranges / reverse DNS that major operators publish (Google,
   Bing, OpenAI, Anthropic, Apple and others). Each bot record has `verified: true | false`. A user agent
   that claims to be a known bot but fails verification is recorded as `claimed_unverified`.
3. **Generic signals**: no user agent, `bot` / `crawler` / `spider` in it, HTTP libraries (`curl`,
   `python-requests`, `Go-http-client`), headless browsers, and `navigator.webdriver` when the script runs.
   These are bots of category `unidentified` (or `automation` / `http_client` when that much is known).

Sophisticated bots that imitate browsers can still pass as humans; no tool catches all of them.

| Category | Examples |
| --- | --- |
| `search` | Googlebot, Bingbot, Applebot, DuckDuckBot, YandexBot, Baiduspider |
| `ai_training` | GPTBot, ClaudeBot, CCBot, Meta-ExternalAgent, Bytespider |
| `ai_search` | OAI-SearchBot, Claude-SearchBot, PerplexityBot |
| `ai_user_fetch` | ChatGPT-User, Claude-User, Perplexity-User (a person asked an assistant to read the page) |
| `social_preview` | facebookexternalhit, Twitterbot, LinkedInBot, Slackbot, WhatsApp, Discordbot, TelegramBot |
| `ads` | AdsBot-Google, Google-adstxt |
| `seo_tool` | AhrefsBot, SemrushBot, MJ12bot, DotBot |
| `monitoring` | UptimeRobot, Pingdom, Better Stack |
| `feed` | Feedly and other feed readers |
| `http_client` | curl, python-requests, Go-http-client |
| `automation` | Headless Chrome, Playwright, Selenium |
| `unidentified` | Looks like a bot, no known identity |

**What is recorded per bot request:** time, path, status code, response size, bot name, category,
`verified`, country and network (ASN; not the IP), and whether the path is a special file (`robots.txt`,
`sitemap.xml`, `llms.txt`, Markdown versions of pages). That answers questions such as how often Meta's or
Google's bots come, which pages AI crawlers read, and whether they follow `llms.txt`.

Visits referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot, Claude) are human traffic and are
marked `referrer_type: ai_assistant`.

## 8. Destinations

Destinations are configured in the collector, never in the page:

```json
{
  "destinations": [
    {
      "type": "ga4",
      "measurementId": "G-XXXXXXX",
      "secretEnv": "GA4_API_SECRET",
      "events": { "page_view": "page_view", "signup_click": "sign_up" }
    },
    {
      "type": "meta_capi",
      "pixelId": "123",
      "tokenEnv": "META_CAPI_TOKEN",
      "events": { "lead_submit": "Lead" }
    }
  ]
}
```

- `events` maps Tinybeam event names to destination names; unmapped events are not sent.
- Advertising destinations (GA4, Meta, Google Ads) only receive events whose `ads_consent` is `granted`
  or `not_required` (section 5). GA4 events carry the matching consent signals (`ad_user_data`,
  `ad_personalization`, Google's Consent Mode v2). Events without an anonymous ID can't go to destinations
  that require one.
- Bot traffic is never forwarded by default. A destination can opt in with `"bots": true` or a list of
  categories (for example `"bots": ["ai_user_fetch"]`); bot events then carry their category and
  `verified` flag.
- Delivery goes through a queue with retries, so a slow destination never delays the response to the browser.

### Attributes on forwarded events

Attributes are sent once (section 3), but destinations need them on every event they apply to. So the
collector resolves them for each forwarded event:

- It keeps the current attributes of each page view, session and user (page: while the page is open;
  session: until it expires; user: in a user table, since it lasts across sessions) and merges them into
  each event with the usual precedence (event, page, session, user). An event sent after `setSession`
  without the attribute still reaches GA4 with it.
- Each destination maps attributes to what the platform supports, chosen in the portal. In GA4, for
  example, user attributes can go as user properties and page and session attributes as event parameters;
  the `setUser` ID goes as `user_id`. What a platform has no place for can't be sent there.
- Destinations can't be corrected after the fact, so an attribute set late can only reach events not yet
  forwarded. Each destination chooses when to forward:

  | Mode | Forwards | Complete for |
  | --- | --- | --- |
  | Immediate | as each event arrives | attributes set before the event |
  | End of page (default) | when the page is left or hidden | page attributes |
  | End of session | 30 min after the last activity | page and session attributes |

  Events keep the time they happened; GA4 and Meta accept late events within their limits (hours to
  days). The documentation will advise setting attributes as early as possible, ideally with the page
  view (`data-page-<key>`, or the set calls before the first `track`).

## 9. Size budget

| Bundle | Budget (brotli) |
| --- | --- |
| Core (including SPA navigation and consent) | 1.5 KB |
| Core + keeping the ID in the page (`tinybeam-ids.js`) | 1.75 KB |
| Core + sections | 2 KB |
| Core + all modules | 3 KB |

- Bundles are minified: no whitespace or comments, local names shortened.
- The consent banner (`/tb/banner.js`, section 5) is outside these budgets: it's loaded only for visitors
  who must see it, never on every page view.
- Old browsers are measured, not dropped. The source sticks to syntax that every browser since 2017 parses
  (ES2015: no optional chaining, nullish coalescing or class fields), which costs almost nothing in size,
  and the minifier never emits newer syntax. No polyfills are shipped: each browser API is feature-detected
  and the script degrades instead of failing, always recording what was missing (`cap`, section 3):
  - sending: `navigator.sendBeacon`, then `XMLHttpRequest` (reported in `tx`);
  - sections: skipped where `IntersectionObserver` is missing;
  - vitals: each metric is sent only where the browser exposes it (INP, for example, is Chromium-only).
- Browsers that can't run the script at all (very old ones, or with JavaScript disabled) are still counted:
  the collector logs page views from the HTML requests themselves or the noscript pixel (section 7), with
  the same enrichment and without engagement data.
- Budgets are measured on the minified bundle compressed with brotli, which is what the browser downloads.
  The uncompressed minified size is reported too, since that is what the browser parses.
- CI fails if a bundle exceeds its budget.

## 10. Decisions

Settled during review (2026-11-07):

1. **Sessions** end after 30 min without events, GA4's default, so numbers are comparable. No midnight cut.
2. **No per-tab ID without consent.** `sessionStorage` may count as device storage under ePrivacy, so
   nothing is stored without consent (except the cookie that remembers a refusal, section 5).
3. **Storage** is any SQL database through a minimal driver (SQLite and D1 included), so the collector
   isn't tied to a provider. Superseded the earlier plan of Workers Analytics Engine + R2.
4. **One file per site.** Modules are selected at build time and bundled into a single script, so the page
   makes one request.
5. **Event names** follow GA4 where an equivalent exists (`page_view`, `search`, `sign_up`, `login`,
   `generate_lead`); Tinybeam names are used only for what GA4 doesn't have (`engagement`, `section_view`,
   `vitals`, `outbound`, `download`).
6. **Missing data is explicit.** Every measurement is measured, no value, unsupported or not instrumented,
   and every aggregate reports its base (section 3).
7. **Visits without JavaScript count**, through server-side page views and a noscript pixel (section 7).
8. **Bots are measured separately**, classified by name and category with verification where possible,
   excluded from human reports and from destinations unless opted in (sections 7 and 8).
9. **Core budget is 1.5 KB** and SPA navigation is part of the core, not a separate bundle: one script fits
   every site, and the extra half kilobyte has no measurable effect on loading.
10. **The page view is sent as soon as the script runs**, not after the `load` event.
11. **The collector runs anywhere** (web-standard APIs, platform adapters), and the script can send to a
    collector on another domain, so the same code serves self-hosting and a hosted service.
12. **The site ID is always required**, self-hosted or hosted, with one site or many.
13. **Four attribute scopes** (event, page, session, user) with one call each: `track`, `setPage`,
    `setSession`, `setUser`, plus `reset`. Page and session attributes apply to the whole page or session,
    including earlier events, and are resolved when querying. `setPage` waits for the next send; the
    others are sent at once. Replaced `set`, which only lasted for one page in the browser.
14. **Consent by region, set per site.** By default, regions that require consent (EU/EEA, UK, Switzerland)
    start anonymous and see a banner; elsewhere measurement is full by default with an opt-out, and Global
    Privacy Control is always honored. Each site can ask everyone, never ask, or change the regions in the
    portal. A refusal is counted without any identifier (or not at all), since measuring someone who
    refused with an identifier, even a daily one, is the riskiest case under the GDPR. Every event records
    its consent state, so dashboards count and filter by it. Tinybeam's own banner is optional, in a
    separate file, with texts per language; sites with a CMP call `tinybeam.consent()` instead.
15. **Three ways to keep the stable ID**, recorded on every event as `id_store`: the collector under the
    site's own path (recommended, 13 months), a small endpoint on the site's server with events sent to a
    collector anywhere (13 months), or cookies written by the script (nothing to install, 7 days in
    Safari). A subdomain pointing to another provider is not offered as equivalent, since Safari caps
    cookies set by a server whose IP address doesn't match the site's. The endpoint generates the ID itself
    instead of receiving it, so no one can plant an ID in a visitor's browser. The owner doesn't choose
    among them: the portal asks where the site is hosted and shows only the way that fits (portal,
    Installation).
