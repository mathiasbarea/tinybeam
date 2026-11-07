// A complete Tinybeam server on Node.js 22.5+: collector and portal, storing in SQLite.
// Run: npm start (builds the script first), then open http://localhost:8787/portal/ to create the owner
// account and add sites.
// Put it behind your domain with a reverse proxy: /tb/ on your site (first-party collection) and the
// portal wherever you like (a subdomain, a path, another domain).
import { readFileSync } from 'node:fs';
import { createTinybeam } from '../app.js';
import { serve, sqliteDriver } from '../collector/node.js';

const app = createTinybeam({
  driver: await sqliteDriver(process.env.TINYBEAM_DB || 'tinybeam.db'),
  script: readFileSync(new URL('../dist/tinybeam.js', import.meta.url), 'utf8'),
  // Secure cookies need HTTPS; browsers other than Safari also accept them on http://localhost.
  secureCookies: process.env.INSECURE_COOKIES !== '1',
});

const port = Number(process.env.PORT || 8787);
// trustProxy: the client IP comes from X-Forwarded-For; only enable it behind a proxy you control.
await serve(app, { port, trustProxy: process.env.TRUST_PROXY === '1' });
console.log(`Tinybeam on http://localhost:${port}/portal/ (collector at /tb/)`);
