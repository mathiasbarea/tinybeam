// A standalone collector on Node.js 22.5+, storing in SQLite. Run: node examples/node-server.js
// Put it behind your site's domain (a reverse proxy rule for /tb/) so the script stays first-party, or
// point the script at it with data-endpoint.
import { createCollector } from '../collector/index.js';
import { serve, sqliteStorage } from '../collector/node.js';

const collector = createCollector({
  storage: await sqliteStorage(process.env.TINYBEAM_DB || 'tinybeam.db'),
  // sites: [{ id: 'my-site', origins: ['https://example.com'] }],
});

const port = Number(process.env.PORT || 8787);
// trustProxy: the client IP comes from X-Forwarded-For; only enable it behind a proxy you control.
await serve(collector, { port, trustProxy: process.env.TRUST_PROXY === '1' });
console.log(`Tinybeam collector on http://localhost:${port}/tb/e`);
