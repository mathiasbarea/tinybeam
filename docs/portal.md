# Tinybeam portal (draft)

Status: **partly implemented.** Done: the owner account (setup, sign-in, sessions), sites (add, edit,
pause, delete, snippet) stored in SQL and read by the collector, and first dashboards (overview, events
with resolved attributes, bots and AI). The rest is a draft. This describes the
web portal that comes with the collector. It
complements [`spec.md`](spec.md), which covers the script, the wire format and the collector.

## Goal

Everything a site owner does with Tinybeam happens in a web portal, never in a terminal: adding sites,
filtering traffic, transforming events, forwarding them to other platforms, and looking at the data. The
same portal serves both setups:

- **Self-hosted:** whoever runs the collector gets the portal with it, on a URL they choose: a subdomain
  (`analytics.example.com`), a path (`example.com/analytics`), or another domain they own.
- **Hosted:** a Tinybeam service runs the same portal for many accounts, for people who don't want to run
  anything. Their sites only include the script.

## One deployable

The portal, its API and the collector are one application on the same web-standard `Request` /
`Response` handler, so the portal runs wherever the collector runs (Node.js, Deno, Bun, Cloudflare
Workers…) and stores its configuration in the same SQL database through the same driver. Base paths are
configurable: the collector can answer on the site's own domain (`/tb/`, first-party) while the portal
lives elsewhere.

The collector already reads sites through `sites: async id => site | null`; the portal is what writes
them.

## Accounts and access

- First run: a setup page creates the owner account. No default passwords.
- Sign-in with email and password (hashed with a slow KDF), sessions in an `HttpOnly` cookie, optional
  passkeys later.
- Roles per site: owner, admin (configuration), viewer (dashboards only).
- Hosted mode adds organizations (accounts that own sites, members, billing). Self-hosted mode is a single
  organization.

## Sites

The equivalent of a GA4 property. Adding a site takes a name and its origins and returns its ID and the
snippet to paste (script tag and noscript pixel). A site can be paused (data rejected) or deleted (data
removed after a grace period).

## Consent

Per site (spec, section 5):

- mode: automatic by region (default), ask everyone, or never ask (anonymous only, or full everywhere),
- the regions that require consent, country by country (default: EU/EEA, United Kingdom, Switzerland),
- what a refusal means: counted without an identifier (default) or not measured,
- the banner: Tinybeam's own or the site's existing one (a CMP calling `tinybeam.consent()`); for
  Tinybeam's, the default language or "follow the page", texts per language (built-in translations,
  editable, more languages can be added), the privacy policy link per language, position and colors, and
  a preview.

## Filters

Per site, decide what is not recorded at all:

- internal traffic: by IP or IP range (compared at ingest, never stored), or by an opt-out link that sets a
  first-party flag in the owner's browser,
- hostnames (staging, preview deployments) and paths,
- bots: stored separately by default (spec, section 7); can be dropped entirely.

## Transformations

Rules applied to each event after enrichment and before storage and forwarding, in order:

- rename an event (`signup_click` → `sign_up`),
- rename, drop or set properties (for example, scrub anything that looks like an email address),
- drop events that match a condition,
- derive an event from another (a `page_view` on `/thanks/` → `generate_lead`).

Rules are declarative (conditions on event name, path, properties, traffic type), not arbitrary code, so
a hosted collector can run them safely. Each rule shows how many events it matched recently.

## Destinations

Forward events to other platforms from the server, per site (spec, section 8):

- choose the destination (GA4 Measurement Protocol, Meta Conversions API, Google Ads conversions, a
  webhook…) and enter its credentials, stored encrypted,
- map events (which Tinybeam events go, under which names) and properties,
- choose the identifiers: which ID goes as GA4 `client_id` (Tinybeam's anonymous ID, or another one), what
  `user_id` is, and so on,
- whether bots go (off by default); advertising destinations only receive events with advertising consent,
- a delivery log with recent successes and failures, and a test button that sends one event.

Platforms that only work as a script in the page (Microsoft Clarity, Hotjar) can't receive events from a
server. For those, the portal shows how to pass them the Tinybeam ID, so their recordings can be matched to
Tinybeam's data.

## Dashboards

Per site, with a date range and filters on any dimension:

- visitors, page views, visible time, scroll depth; top pages; sources, referrer types and campaigns;
  countries, devices, browsers,
- custom events and their properties: counts, breakdowns by any property,
- sections seen and Web Vitals (once those modules exist), always with their base (spec, section 3),
- visits without JavaScript,
- consent: visitors and sessions per consent state, and every report filterable by it,
- bots: by name, category and page, how often they come, special files (`robots.txt`, `llms.txt`),
- AI: crawlers reading the site and visits referred by AI assistants.

## Order of work

1. Configuration in the database and the collector reading it (done for sites; filters next).
2. Accounts and the portal shell: sign-in, sites, snippet (done for the owner; roles and more users next).
3. Dashboards over the stored events (first version done: date ranges; filters on any dimension next).
4. Consent: states recorded per event, region settings, the optional banner.
5. Transformations.
6. Destinations, starting with GA4 Measurement Protocol.
7. Hosted mode: organizations and billing.
