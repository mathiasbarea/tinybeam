// A standalone collector on Node.js 22.5+, storing in SQLite. Run: node examples/node-server.js
// Put it behind your site's domain (a reverse proxy rule for /tb/) so the script stays first-party, or
// point the script at it with data-endpoint.
import { createCollector } from '../collector/index.js';
import { serve, sqliteStorage } from '../collector/node.js';

const collector = createCollector({
  storage: await sqliteStorage(process.env.TINYBEAM_DB || 'tinybeam.db'),
  // One entry per site: its ID (generate one with `npm run site-id`), a name, and the origins its pages
  // are served from. The pages' script tag carries the same ID in data-site.
  sites: [{ id: process.env.TINYBEAM_SITE_ID || 'replace-me', name: 'My site', origins: ['https://example.com'] }],
});

const port = Number(process.env.PORT || 8787);
// trustProxy: the client IP comes from X-Forwarded-For; only enable it behind a proxy you control.
await serve(collector, { port, trustProxy: process.env.TRUST_PROXY === '1' });
console.log(`Tinybeam collector on http://localhost:${port}/tb/e`);
