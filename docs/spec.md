# Tinybeam spec (draft)

Status: **draft.** Nothing here is implemented yet; names and fields may change until the first release.
Decisions taken during review are listed at the end.

## 1. Scope

This document defines:

- the events the browser script sends and their fields,
- how every measurement records whether the browser could take it (capabilities and coverage),
- the identity model (anonymous ID, session, user ID) and how it maps to destinations,
- the consent modes,
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
  Available today: the core (`tinybeam.js`), which includes SPA navigation.
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
    assigned (section 7). Empty means the script generates one.
- Neutral paths (`/tb/`) are recommended; names such as `analytics.js` are commonly blocked by filter lists.
- Page API: `tinybeam.track(name, props)` queues a custom event; `tinybeam.flush()` sends the queue now.

## 3. Events

Every event shares an envelope (section 6). Event-specific fields go in `p` (properties).

### Core

| Event | When | Properties |
| --- | --- | --- |
| `page_view` | Page load, restore from the back/forward cache, and History API navigations | `title`, `ref` (referrer, when there is one) |
| `engagement` | When the page is hidden, and before an SPA navigation; not sent when no visible time passed | `ms` (visible time since the last `engagement`), `scroll` (max depth reached: 0, 25, 50, 75, 100) |
| `outbound` | Click (or middle click) on a link to another host | `url` |
| `download` | Click on a link with a `download` attribute or whose path ends in a file extension other than a web page (`.html`, `.htm`, `.php`, `.asp`, `.aspx`) | `url` |
| custom | `tinybeam.track(name, props)` or click on an element with `data-tb-event` | free-form, flat, string/number/boolean values |

`data-tb-event="signup_click"` on an element sends that event on click; `data-tb-prop-<key>="value"`
attributes become its properties. Clicks are sent right away, since they may leave the page.

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
| Anonymous ID | `aid` | Depends on consent mode (section 5) | Collector (cookie) or script |
| Session ID | `sid` | Ends after 30 min without events | Collector |
| User ID | `uid` | Set by the site with `tinybeam.identify(userId, traits)` | Site |
| Page view ID | `pv` | One page view; ties `engagement`, `section_view` and `vitals` to their `page_view` | Script |

- With consent, the anonymous ID is an `HttpOnly`, `Secure`, `SameSite=Lax` first-party cookie set by the
  collector, so it survives the 7-day cap that Safari applies to cookies and storage written by JavaScript.
- `identify` links the anonymous ID to the user ID in the collector. Earlier events stay attached to the
  anonymous ID; destinations that support it receive both.
- Format: 128-bit random values as URL-safe text (the script uses base 36), no embedded meaning.

### Mapping to destinations

| Destination | Tinybeam → destination |
| --- | --- |
| GA4 Measurement Protocol | `aid` → `client_id`, `uid` → `user_id`, `sid` → `session_id`, `engagement.ms` → `engagement_time_msec` |
| Meta Conversions API | `uid` (SHA-256) → `external_id`; `_fbp` / `_fbc` cookies or `fbclid` when present |
| Microsoft Clarity, Hotjar | `tinybeam.id()` exposes `aid` to the page so it can be passed to their own `identify` |

## 5. Consent modes

| Mode | Storage | Anonymous ID | What you lose |
| --- | --- | --- | --- |
| `anonymous` (default) | None | Daily hash computed by the collector: `hash(daily salt, site, IP, user agent)`. The salt rotates every 24 h and is discarded; the IP is never stored | Returning visitors across days, cross-day attribution |
| `consented` | First-party cookie set by the collector | Stable random ID | — |

- The site switches modes with `tinybeam.consent(true | false)`; revoking deletes the cookie.
- If the browser sends Global Privacy Control (`Sec-GPC: 1`), the collector stays in `anonymous` mode and
  does not forward to advertising destinations, regardless of other settings.

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

### Enrichment

The collector adds, per event:

- `device` (`mobile`, `tablet`, `desktop`), `browser`, `browser_version`, `os`, `os_version`, from the user
  agent and User-Agent Client Hints when available,
- `country`, `region`, `city` from the platform or headers; the IP itself is not stored,
- `aid`, `sid` (section 4); bots get no session,
- on page views: `referrer_type` (`direct`, `internal`, `paid`, `email`, `ai_assistant`, `search`,
  `social`, `referral`), `referrer_host`, campaign parameters and the first click ID found
  (`click_id_type`, `click_id`),
- `traffic` (`human` or `bot`) and, for bots, `bot_name`, `bot_category`, `bot_verified`.

Computed when querying, not stored: `engaged_session` (more than 10 s of visible time, two page views, or a
conversion event), `new_visitor` (`consented` mode).

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
      "events": { "page_view": "page_view", "signup_click": "sign_up" },
      "consent": "consented"
    },
    {
      "type": "meta_capi",
      "pixelId": "123",
      "tokenEnv": "META_CAPI_TOKEN",
      "events": { "lead_submit": "Lead" },
      "consent": "consented"
    }
  ]
}
```

- `events` maps Tinybeam event names to destination names; unmapped events are not sent.
- `consent` sets the minimum consent mode for that destination.
- Bot traffic is never forwarded by default. A destination can opt in with `"bots": true` or a list of
  categories (for example `"bots": ["ai_user_fetch"]`); bot events then carry their category and
  `verified` flag.
- Delivery goes through a queue with retries, so a slow destination never delays the response to the browser.

## 9. Size budget

| Bundle | Budget (brotli) |
| --- | --- |
| Core (including SPA navigation) | 1.5 KB |
| Core + sections | 2 KB |
| Core + all modules | 3 KB |

- Bundles are minified: no whitespace or comments, local names shortened.
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
2. **No per-tab ID in `anonymous` mode.** `sessionStorage` may count as device storage under ePrivacy, so
   nothing is stored without consent.
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
