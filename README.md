# Tinybeam

First-party web analytics that weighs almost nothing.

Tinybeam is a tiny browser script plus a collector you can run anywhere. The script measures what people
actually do on a page and sends it to the collector; the collector enriches the events, stores them and
forwards them to wherever you want them: your own database, GA4, Meta, or any other destination.

> **Status: early development.** The browser core and the collector are written and tested; the browser
> modules (sections, Web Vitals), consent mode and destinations are next. The event and identity model is drafted in
> [`docs/spec.md`](docs/spec.md). Feedback is welcome in issues.

## Why

Third-party analytics tags are heavy, run code you don't control, and talk to other companies' servers from
your visitors' browsers. A typical GA4 setup ships 100 KB+ of JavaScript, and most of its cost on mobile is
main-thread time, not download time. Each additional tool (session replay, ad pixels, a CDP) adds another one.

Tinybeam takes the opposite approach:

- **Measure once, in the browser, with the smallest possible script.** Almost everything GA4 collects
  (page title, URL, referrer, language, screen, campaign parameters, engagement time, scroll, outbound
  clicks, downloads, site search) is already exposed by the browser and costs a few bytes to read.
- **Do the rest on the server.** Device, browser, OS, country, sessions, new vs. returning visitors and
  engaged sessions are derived by the collector, at no cost to the page.
- **Forward from the server.** One stream of events, mapped and routed to each destination, instead of one
  script per vendor in the page.

## Principles

1. **Tiny.** Core under 1.5 KB compressed; core plus every module under 3 KB. Loaded with `defer`, so it
   never blocks rendering. A size budget is enforced in CI.
2. **First-party.** The script and the collector can live on your own domain: no new connections, no
   third-party cookies, no vendor code in the page. The script can also send to a collector elsewhere,
   such as a hosted one.
3. **Private by default.** No cookies and no persistent identifier without consent. No IP addresses
   stored. No fingerprinting. Respects Global Privacy Control.
4. **One identity, many destinations.** Tinybeam owns a stable anonymous ID and translates it for each
   destination (for example GA4 `client_id`, Meta `external_id`, Clarity `identify`).
5. **Honest about gaps.** Old browsers are measured, not dropped. Whatever a browser can't measure is
   flagged instead of silently missing, so every number comes with the base it was computed from (for
   example, how many visitors were excluded from INP because their browser doesn't support it).
6. **Modular.** Each site ships only the modules it uses.
7. **Runs anywhere.** The collector is built only on web-standard APIs, so the same code runs on Node.js,
   Deno, Bun, Cloudflare Workers and other runtimes, and stores in any SQL database through a two-method
   driver. Nothing ties it to one provider. The wire format is documented so other collectors can exist.

## What it measures

| Area | Data | Where |
| --- | --- | --- |
| Page views | URL, title, referrer, language, viewport and screen, time zone, UTM and click IDs | Browser (core) |
| Engagement | Visible time on page, scroll depth (25/50/75/100%) | Browser (core) |
| Links | Outbound clicks, file downloads, site search | Browser (core) |
| Custom events | `tinybeam.track(name, props)` and `data-tb-event` attributes | Browser (core) |
| Sections | Which marked sections and components were seen, and for how long | Browser (module) |
| Web Vitals | LCP, INP, CLS, TTFB from real visitors | Browser (module) |
| Context | Device, browser, OS, country, region | Collector |
| Sessions | Sessions, new vs. returning (with consent), engaged sessions | Collector |
| Coverage | Which browser features were available, so gaps are counted instead of hidden | Browser (core) |
| Visits without JavaScript | Page views from the HTML requests themselves and a noscript pixel | Collector |
| Bot traffic | Every identifiable bot by name and category (search, AI crawlers, social previews, SEO tools…), verified where possible, plus unidentified bots. Kept apart from human traffic and not forwarded to destinations unless you opt in | Collector |
| AI referrals | Visits referred by AI assistants (ChatGPT, Perplexity, Gemini…) | Collector |

## Non-goals

- **Session replay and heatmaps.** They require capturing the DOM and add tens of kilobytes. Use a
  dedicated tool and pass it the Tinybeam ID.
- **Google demographics and Google Signals.** These come from Google's own identification of signed-in
  users in the browser; no first-party or server-side tool can provide them. Sites that need them can load
  the GA4 tag after consent alongside Tinybeam.
- **Being a full customer data platform.** Destinations are deliberately few and well maintained.

## How it fits together

```
browser                         collector (any runtime)                 destinations
───────                         ───────────────────────                 ────────────
tinybeam.js ── sendBeacon ──▶   POST /tb/e
  core + modules                  validate, enrich (UA, geo, session)
                                  store ─────────────────────────────▶  SQLite, D1, Postgres, …
                                  route + map IDs ───────────────────▶  GA4 Measurement Protocol,
                                                                        Meta Conversions API, … (planned)
```

## Using it

**1. Add the script** to your pages. It can be served from your own domain (recommended):

```html
<script src="/tb/tinybeam.js" data-site="YOUR_SITE_ID" data-pv defer></script>
```

| Attribute | Meaning |
| --- | --- |
| `data-endpoint` | Where to send events. Default `/tb/e` on the same site; can be a full URL to a collector elsewhere. |
| `data-site` | **Required.** The site's ID, registered in the collector. Without it the script doesn't measure. |
| `data-pv` | Left empty; a collector in front of the site fills in the page view ID (see below). |

Optionally, to count visitors with JavaScript disabled:

```html
<noscript><img src="/tb/n?s=YOUR_SITE_ID" alt="" width="1" height="1"></noscript>
```

**2. Register the site.** Every site has an ID, whether you run your own collector for one site or use
a collector shared by many. Generate one with `npm run site-id` and list it in the collector's `sites`
with the origins its pages are served from; the collector only accepts registered sites and origins. A
collector with a site registry elsewhere (a database, an admin UI) passes `sites` as a function
`async id => site | null`.

**3. Run a collector.** Three ways, all with the same code:

- **Standalone on Node.js** (22.5+), storing in SQLite: [`examples/node-server.js`](examples/node-server.js).
  Route `/tb/` on your domain to it with your reverse proxy (nginx, Caddy, your host's rewrites) to keep
  it first-party.
- **In front of your site** (Cloudflare Worker, or any server that sees your page requests):
  [`examples/cloudflare-worker.js`](examples/cloudflare-worker.js). Besides the script's events it records
  server-side page views (visits whose browser never ran the script) and every bot request.
- **Inside your own server**: `collector.handle(request, context)` takes a standard `Request` and returns a
  `Response`, so it mounts in any framework that speaks web-standard requests (Hono, Next.js route
  handlers, Remix, SvelteKit, Deno, Bun…). The Node.js adapter (`fromNode`, `toNode`) covers Express-style
  servers.

```js
import { createCollector, sqlStorage } from 'tinybeam/collector';

const collector = createCollector({
  storage: sqlStorage(myDriver), // { exec(sql), run(sql, params) } over any SQL client
  sites: [{ id: 'k3v9x2m7q1za', name: 'Example', origins: ['https://example.com'] }],
});
```

`context` carries what the platform knows about the client: `ip` (used only to compute the daily
anonymous ID, never stored), `country`/`region`/`city`, `verifiedBotCategory` and `waitUntil`, plus
`site` when calling `observe`. Adapters
fill it in; without one, country is read from common CDN headers.

## Development

Requires Node.js 22.5 or later (SQLite tests use `node:sqlite`).

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the bundles into `dist/` and prints their minified and brotli sizes. |
| `npm run size` | Same, and fails if a bundle is over its budget. |
| `npm test` | Runs the browser bundles in jsdom (what they send, ES2015 syntax, size budgets) and the collector (validation, enrichment, bots, storage, adapters). |

The browser script is `src/core.js`; modules will be build flags in `build.mjs` (code behind a flag that
is off is dropped from that bundle). The collector is `collector/`: `index.js` (handling and records),
`enrich.js` (user agent, referrer, campaign, geo), `bots.js` (the bot list), `storage.js`, and the
platform adapters `node.js` and `cloudflare.js`.

| Bundle | Contents | Size (brotli) | Budget |
| --- | --- | --- | --- |
| `tinybeam.js` | Core, including History API navigations | 1,133 B | 1,536 B |

## Roadmap

1. Spec: events, identity, consent modes, wire format ([`docs/spec.md`](docs/spec.md)).
2. Browser core (done) and modules (sections, Web Vitals), with a size budget in CI.
3. Portable collector with SQL storage, Node.js and Cloudflare adapters (done); consent mode.
4. The portal, on a URL the owner chooses: sites, filters, transformations, destinations and dashboards,
   with no terminal needed ([`docs/portal.md`](docs/portal.md)).
5. First destinations: GA4 Measurement Protocol and Meta Conversions API.
6. Dogfooding on [mathiasbarea.com](https://mathiasbarea.com).
7. A hosted service running the same portal and collector, for sites that don't want to run one.

## License

[MIT](LICENSE)
