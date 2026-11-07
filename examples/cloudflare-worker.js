// A Cloudflare Worker in front of a site: answers the collector routes, serves everything else from the
// site's assets (or origin), records server-side page views and bot requests, and hands each page its
// page view ID. Bindings: DB (D1) and ASSETS (static assets) in wrangler.jsonc; vars: SITE_ID and
// SITE_ORIGIN (for example "https://example.com").
import { createCollector, sqlStorage } from '../collector/index.js';
import { cloudflareContext, d1Driver } from '../collector/cloudflare.js';

let collector;

export default {
  async fetch(request, env, ctx) {
    collector ??= createCollector({
      storage: sqlStorage(d1Driver(env.DB)),
      sites: [{ id: env.SITE_ID, origins: [env.SITE_ORIGIN] }],
    });
    const context = { ...cloudflareContext(request, ctx), site: env.SITE_ID };
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/tb/')) return collector.handle(request, context);

    const response = await env.ASSETS.fetch(request); // or fetch(request) for a site behind an origin
    const pv = await collector.observe(request, response, context);
    if (!pv) return response;
    // Give the script the same page view ID, so its events merge with the server's record. The page's
    // script tag carries an empty data-pv attribute for this.
    return new HTMLRewriter()
      .on('script[data-pv]', { element: el => el.setAttribute('data-pv', pv) })
      .transform(response);
  },
};
