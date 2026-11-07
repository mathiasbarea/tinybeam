# Tinybeam

First-party web analytics that weighs almost nothing.

Tinybeam is a tiny browser script plus a collector that runs on your own domain. The script measures what
people actually do on a page and sends it to your server; your server enriches the events and forwards them
to wherever you want them: your own storage, GA4, Meta, or any other destination.

> **Status: early development.** The browser core is written and tested; the modules (sections, Web
> Vitals) and the collector are next. The event and identity model is drafted in
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

1. **Tiny.** Core under 1 KB compressed; core plus every module under 3 KB. Loaded after the page is
   interactive. A size budget is enforced in CI.
2. **First-party.** The script and the collector live on your own domain. No new connections, no
   third-party cookies, no vendor code in the page.
3. **Private by default.** No cookies and no persistent identifier without consent. No IP addresses
   stored. No fingerprinting. Respects Global Privacy Control.
4. **One identity, many destinations.** Tinybeam owns a stable anonymous ID and translates it for each
   destination (for example GA4 `client_id`, Meta `external_id`, Clarity `identify`).
5. **Honest about gaps.** Old browsers are measured, not dropped. Whatever a browser can't measure is
   flagged instead of silently missing, so every number comes with the base it was computed from (for
   example, how many visitors were excluded from INP because their browser doesn't support it).
6. **Modular.** Each site ships only the modules it uses.
7. **Edge-native.** The reference collector targets Cloudflare Workers (Analytics Engine, Queues, R2),
   with no servers to run. The wire format is documented so other collectors can exist.

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
browser                         your domain (collector)                 destinations
───────                         ───────────────────────                 ────────────
tinybeam.js ── sendBeacon ──▶   POST /tb/e                              
  core + modules                  validate, enrich (UA, geo, session)   
                                  store ─────────────────────────────▶  Analytics Engine / R2 / SQL
                                  route + map IDs ───────────────────▶  GA4 Measurement Protocol,
                                                                        Meta Conversions API, …
```

## Development

Requires Node.js 20 or later.

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the bundles into `dist/` and prints their minified and brotli sizes. |
| `npm run size` | Same, and fails if a bundle is over its budget. |
| `npm test` | Runs the bundles in jsdom and checks what they send, that they parse as ES2015 and fit their budgets. |

The source is `src/core.js`. Modules are build flags in `build.mjs`: code behind a flag that is off is
dropped from that bundle.

| Bundle | Contents | Size (brotli) | Budget |
| --- | --- | --- | --- |
| `tinybeam.js` | Core | 1,022 B | 1,024 B |
| `tinybeam.spa.js` | Core + History API navigations | 1,125 B | 1,152 B |

## Roadmap

1. Spec: events, identity, consent modes, wire format ([`docs/spec.md`](docs/spec.md)).
2. Browser core (done) and modules, with a size budget in CI.
3. Reference collector for Cloudflare Workers, with storage and a minimal dashboard.
4. First destinations: GA4 Measurement Protocol and Meta Conversions API.
5. Dogfooding on [mathiasbarea.com](https://mathiasbarea.com).

## License

[MIT](LICENSE)
