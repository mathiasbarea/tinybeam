// The whole Tinybeam server in one handler: the collector (events, noscript pixel, the script itself) and
// the portal, sharing one SQL database. Sites added in the portal are the sites the collector accepts.
import { createCollector, sqlStorage } from './collector/index.js';
import { createPortal } from './portal/index.js';
import { createQueries } from './portal/queries.js';
import { createStore } from './portal/store.js';

export function createTinybeam({ driver, script = null, collectorPath = '/tb', portalPath = '/portal', secureCookies = true, ...collectorOptions }) {
  const store = createStore(driver);
  const collector = createCollector({
    storage: sqlStorage(driver),
    sites: store.activeSite,
    path: collectorPath,
    script,
    ...collectorOptions,
  });
  const portal = createPortal({ store, queries: createQueries(driver), basePath: portalPath, collectorPath, secureCookies });

  return {
    collector,
    portal,
    store,
    handle(request, context = {}) {
      const { pathname } = new URL(request.url);
      if (pathname === portalPath || pathname.startsWith(portalPath + '/')) return portal.handle(request);
      if (pathname.startsWith(collectorPath + '/')) return collector.handle(request, context);
      return new Response('Not Found', { status: 404 });
    },
  };
}
