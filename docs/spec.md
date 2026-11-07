# Tinybeam spec (draft)

Status: **draft.** Nothing here is implemented yet; names and fields may change until the first release.
Decisions taken during review are listed at the end.

## 1. Scope

This document defines:

- the events the browser script sends and their fields,
- the identity model (anonymous ID, session, user ID) and how it maps to destinations,
- the consent modes,
- the wire format between the script and the collector,
- what the collector adds on its own.

## 2. Loading

```html
<script type="module" src="/tb/tinybeam.js" data-endpoint="/tb/e" async></script>
```

- One file per site: the modules the site uses are selected at build time and bundled with the core.
- Served from the site's own origin with long-lived, immutable caching (hashed file name in builds).
- Does nothing until the page has loaded; work is scheduled with `requestIdleCallback` where available.
- Configuration comes from `data-*` attributes on the script tag or from `tinybeam.init({...})`.
- Neutral paths (`/tb/`) are recommended; names such as `analytics.js` are commonly blocked by filter lists.

## 3. Events

Every event shares an envelope (section 6). Event-specific fields go in `p` (properties).

### Core

| Event | When | Properties |
| --- | --- | --- |
| `page_view` | Page load and SPA navigations (History API) | `title`, `ref` (referrer), `utm_*`, click IDs (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`) |
| `engagement` | When the page is hidden or unloaded, and on SPA navigation | `ms` (visible time since the last `engagement`), `scroll` (max depth reached: 0, 25, 50, 75, 100) |
| `outbound` | Click on a link to another host | `url` |
| `download` | Click on a link to a file (configurable extensions) | `url`, `ext` |
| `search` | Page view whose URL has a configured search parameter (`q`, `s`, `query`) | `term` |
| custom | `tinybeam.track(name, props)` or click on an element with `data-tb-event` | free-form, flat, string/number/boolean values |

`data-tb-event="signup_click"` on an element sends that event on click; `data-tb-prop-<key>="value"`
attributes become its properties.

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
definitions used by the Chrome UX Report.

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
- Format: 128-bit random values, base64url, no embedded meaning.

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
body as JSON. Events are batched and flushed when the page is hidden, on SPA navigation, or when the batch
reaches 20 events. Falls back to `fetch(..., { keepalive: true })`.

```json
{
  "v": 1,
  "u": "https://example.com/pricing/?utm_source=newsletter",
  "l": "en-US",
  "sw": 390, "sh": 844, "vw": 390, "vh": 664,
  "tz": "America/Montevideo",
  "pv": "Ck3n2Vq8TtyQ1f0bH4mR7A",
  "e": [
    { "n": "page_view", "t": 1762531200000, "p": { "title": "Pricing", "ref": "https://chatgpt.com/", "utm_source": "newsletter" } },
    { "n": "section_view", "t": 1762531212000, "p": { "id": "plans", "kind": "section", "ms": 8400, "order": 1 } },
    { "n": "engagement", "t": 1762531260000, "p": { "ms": 41200, "scroll": 75 } }
  ]
}
```

- Short keys keep the payload small; the collector expands them.
- `t` is the client time in ms; the collector also records its own receive time and uses it for ordering.
- The collector answers `204 No Content`. Payloads over 16 KB are rejected.

## 7. Collector enrichment

The collector adds, per event:

- `device` (`mobile`, `tablet`, `desktop`, `bot`), `browser`, `browser_version`, `os`, `os_version`, from
  the user agent and User-Agent Client Hints when available,
- `country`, `region`, `city` from the edge (for example `request.cf` on Cloudflare); the IP itself is not stored,
- `sid`, `aid` (section 4), `new_visitor` in `consented` mode,
- `referrer_type`: `direct`, `search`, `social`, `ai_assistant`, `email`, `paid`, `referral`, `internal`,
- `engaged_session`: true once a session has more than 10 s of visible time, two page views, or a conversion
  event.

### AI traffic

The collector can also log, without any browser script:

- requests from AI crawlers identified by user agent (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot,
  Google-Extended and others), with the path requested, including `llms.txt` and Markdown versions of pages,
- visits referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot, Claude), as
  `referrer_type: ai_assistant`.

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
- Delivery goes through a queue with retries, so a slow destination never delays the response to the browser.

## 9. Size budget

| Bundle | Budget (brotli) |
| --- | --- |
| Core | 1 KB |
| Core + sections | 1.5 KB |
| Core + all modules | 3 KB |

CI fails if a bundle exceeds its budget.

## 10. Decisions

Settled during review (2026-11-07):

1. **Sessions** end after 30 min without events, GA4's default, so numbers are comparable. No midnight cut.
2. **No per-tab ID in `anonymous` mode.** `sessionStorage` may count as device storage under ePrivacy, so
   nothing is stored without consent.
3. **Storage** in the reference collector: Workers Analytics Engine for aggregates, with optional raw
   events in R2.
4. **One file per site.** Modules are selected at build time and bundled into a single script, so the page
   makes one request.
5. **Event names** follow GA4 where an equivalent exists (`page_view`, `search`, `sign_up`, `login`,
   `generate_lead`); Tinybeam names are used only for what GA4 doesn't have (`engagement`, `section_view`,
   `vitals`, `outbound`, `download`).
