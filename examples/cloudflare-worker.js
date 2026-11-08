// Tinybeam as a Cloudflare Worker in front of a site: the collector on /tb/, the portal on /portal/ (or
// route a separate hostname to it), and every other request served from the site's assets (or origin),
// recording server-side page views and bot requests and handing each page its page view ID.
// Bindings in wrangler.jsonc: DB (D1), ASSETS (static assets); var SITE_ID (the site's ID from the portal).
// Secret SETUP_TOKEN: until the owner account exists, only /portal/setup?token=<it> can create it.
// To serve the script from the collector, import dist/tinybeam.js as a text module and pass it as
// `script`.
import { createTinybeam } from '../app.js';
import { cloudflareContext, d1Driver } from '../collector/cloudflare.js';

let app;

export default {
  async fetch(request, env, ctx) {
    app ??= createTinybeam({ driver: d1Driver(env.DB), setupToken: env.SETUP_TOKEN });
    const context = { ...cloudflareContext(request, ctx), site: env.SITE_ID };
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/tb/') || pathname.startsWith('/portal')) return app.handle(request, context);

    const response = await env.ASSETS.fetch(request); // or fetch(request) for a site behind an origin
    const pv = await app.collector.observe(request, response, context);
    if (!pv) return response;
    // Give the script the same page view ID, so its events merge with the server's record (the page's
    // script tag carries an empty data-pv attribute for this), and, when the site uses Tinybeam's banner
    // (data-consent="auto"), the visitor's consent state, so the script knows at once whether to ask.
    const consent = await app.collector.consentFor(request, context);
    return new HTMLRewriter()
      .on('script[data-pv]', {
        element(el) {
          el.setAttribute('data-pv', pv);
          if (consent && el.getAttribute('data-consent') === 'auto') el.setAttribute('data-consent', consent);
        },
      })
      .transform(response);
  },
};
