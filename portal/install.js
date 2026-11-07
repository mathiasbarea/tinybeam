// The installation guide (docs/portal.md, Installation): the owner says where the site is hosted, and the
// portal shows only the way to keep the stable ID that works there (docs/spec.md, section 5), ready to
// copy. `origin` is this Tinybeam server's address, as the browser reaches the portal.

export const HOSTS = [
  { key: 'cloudflare', label: 'Cloudflare (Pages or a site behind Cloudflare)', way: 'proxy' },
  { key: 'vercel', label: 'Vercel', way: 'proxy' },
  { key: 'netlify', label: 'Netlify', way: 'proxy' },
  { key: 'nginx', label: 'A server with Nginx', way: 'proxy' },
  { key: 'apache', label: 'A server with Apache', way: 'proxy' },
  { key: 'caddy', label: 'A server with Caddy', way: 'proxy' },
  { key: 'wordpress', label: 'WordPress', way: 'plugin' },
  { key: 'php', label: 'Shared hosting with PHP', way: 'endpoint' },
  { key: 'node', label: 'An app server (Next.js, Remix, Express…)', way: 'endpoint' },
  { key: 'nocode', label: 'Wix, Squarespace, Shopify, GitHub Pages or another host without server rules', way: 'script' },
  { key: 'self', label: 'This Tinybeam server already answers on the site\'s own domain', way: 'self' },
];

// What each way records in id_store, and how long Safari keeps the ID.
export const WAYS = {
  proxy: { idStore: 'collector', lifetime: '13 months' },
  self: { idStore: 'collector', lifetime: '13 months' },
  plugin: { idStore: 'endpoint', lifetime: '13 months' },
  endpoint: { idStore: 'endpoint', lifetime: '13 months' },
  script: { idStore: 'script', lifetime: '7 days in Safari (24 hours when arriving from a link with tracking parameters), 13 months elsewhere' },
};

const proxyRules = (host, origin, path, siteHost) => {
  const domain = new URL(origin).host;
  return {
    cloudflare: { file: `A Worker on the route ${siteHost}${path}/*`, code: `export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-For', request.headers.get('cf-connecting-ip') || '');
    headers.set('X-Tinybeam-Country', (request.cf && request.cf.country) || '');
    return fetch('${origin}' + url.pathname + url.search, { method: request.method, headers, body: request.body });
  },
};` },
    vercel: { file: 'vercel.json', code: `{
  "rewrites": [{ "source": "${path}/:path*", "destination": "${origin}${path}/:path*" }]
}` },
    netlify: { file: '_redirects (in the folder you publish)', code: `${path}/*  ${origin}${path}/:splat  200` },
    nginx: { file: 'The site\'s server block', code: `location ${path}/ {
  proxy_pass ${origin};
  proxy_set_header Host ${domain};
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_ssl_server_name on;
}` },
    apache: { file: 'The site\'s virtual host (needs mod_proxy and mod_proxy_http)', code: `SSLProxyEngine on
ProxyPass "${path}/" "${origin}${path}/"
ProxyPassReverse "${path}/" "${origin}${path}/"` },
    caddy: { file: 'The site\'s Caddyfile block', code: `handle ${path}/* {
  reverse_proxy ${origin} {
    header_up Host {upstream_hostport}
  }
}` },
  }[host];
};

// The script tag and noscript pixel. `local`: served from the site's own domain (proxy or self).
export function snippet(site, { origin, path, banner, idMode = null, local }) {
  const consent = banner ? ' data-consent="auto"' : '';
  if (local) {
    return `<script src="${path}/tinybeam.js" data-site="${site.id}" data-pv${consent} defer></script>
<noscript><img src="${path}/n?s=${site.id}" alt="" width="1" height="1"></noscript>`;
  }
  return `<script src="${origin}${path}/tinybeam-ids.js" data-site="${site.id}" data-endpoint="${origin}${path}/e" data-id="${idMode}"${consent} defer></script>
<noscript><img src="${origin}${path}/n?s=${site.id}" alt="" width="1" height="1"></noscript>`;
}

// The steps for one host: [{ title, text?, code? }].
export function installSteps(hostKey, site, { origin, path, banner }) {
  const host = HOSTS.find(h => h.key === hostKey);
  if (!host) return [];
  const paste = code => ({ title: 'Add this to every page, before </head>', code });
  switch (host.way) {
    case 'proxy': {
      const rule = proxyRules(host.key, origin, path, site.origins && site.origins[0] ? new URL(site.origins[0]).host : 'example.com');
      return [
        { title: `Send ${path}/ on your site to Tinybeam`, text: `${rule.file}. The visitor's browser only talks to your site, so the ID cookie is your site's and lasts 13 months.`, code: rule.code },
        paste(snippet(site, { origin, path, banner, local: true })),
      ];
    }
    case 'self':
      return [paste(snippet(site, { origin, path, banner, local: true }))];
    case 'plugin':
      return [
        { title: 'Install the Tinybeam plugin', text: 'Plugins > Add New > Upload, with the tinybeam folder from examples/wordpress (tinybeam.php and id.php). It adds the script to every page and keeps the ID in your site\'s own cookies.' },
        { title: 'Settings > Tinybeam', text: `Site ID ${site.id}, collector address ${origin}${banner ? ', and check "Use Tinybeam\'s banner"' : ''}.` },
      ];
    case 'endpoint':
      return [
        host.key === 'php'
          ? { title: `Make ${path}/id answer on your site`, text: 'Upload examples/endpoint/id.php so that /tb/id runs it, for example as tb/id/index.php in the web root. It keeps the ID in cookies your server sets, so they last 13 months.' }
          : { title: `Make ${path}/id answer on your site`, text: 'Mount createIdEndpoint() from tinybeam/collector/endpoint at /tb/id: examples/endpoint/next-route.js (Next.js and other web-standard servers) or express.js (Node.js servers). It keeps the ID in cookies your server sets, so they last 13 months.' },
        paste(snippet(site, { origin, path, banner, idMode: 'endpoint', local: false })),
      ];
    default:
      return [
        { title: 'Nothing to set up on your host', text: 'Your host doesn\'t let you add server rules or code, so the script keeps the ID in cookies it writes itself. Safari limits those to 7 days, so returning visitors on Apple devices are recognized for a week.' },
        paste(snippet(site, { origin, path, banner, idMode: 'script', local: false })),
      ];
  }
}

// What the page views of the last days say about the installation: counts by id_store, compared with what
// the chosen host should produce. Returns a message, or null when there's nothing to say yet.
export function checkInstall(hostKey, counts) {
  const host = HOSTS.find(h => h.key === hostKey);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!host) return null;
  if (!total) return { ok: null, text: 'No page views with a stable ID yet. Once visitors who accept (or who need no consent) arrive, this checks how their ID is kept.' };
  const expected = WAYS[host.way].idStore;
  const share = Math.round(((counts[expected] || 0) / total) * 100);
  if (share >= 90) return { ok: true, text: `Working: ${share}% of recent page views with a stable ID kept it as expected (${expected}).` };
  const hints = {
    collector: `Check that ${'/tb/'} on your site reaches Tinybeam (open /tb/tinybeam.js on your site) and that the page loads the script from your own domain.`,
    endpoint: 'Check that /tb/id answers on your site (open it: it should show {"i":…}) and that the page loads tinybeam-ids.js with data-id="endpoint".',
    script: 'Check that the page loads tinybeam-ids.js with data-id="script".',
  };
  return { ok: false, text: `Only ${share}% of recent page views with a stable ID kept it as expected (${expected}); the rest: ${Object.entries(counts).filter(([k]) => k !== expected).map(([k, n]) => `${n} ${k}`).join(', ')}. ${hints[expected]}` };
}
