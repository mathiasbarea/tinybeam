// The ID endpoint (docs/spec.md, section 5, `id_store: endpoint`): a tiny handler that runs on the site's
// own server, at `/tb/id`, and keeps the stable ID and the consent decision in cookies set by that server,
// so Safari doesn't cap them at 7 days. Events still go straight to a collector anywhere.
//
// It is a web-standard handler (Request in, Response out), for servers that speak it: Next.js route
// handlers, Remix, SvelteKit, Hono, Deno, Bun, Cloudflare Workers. examples/endpoint/ has the same logic for
// PHP and plain Node.js.
//
// The cookies aren't HttpOnly, because the script reads them to send the ID with each batch. `tb_r` marks
// that the ID was renewed today, so the script calls GET at most once a day.
import { COOKIE_AGE, cookieHeader, formatDecision, newStableId, parseCookies, parseDecision, validId } from './consent.js';

export function createIdEndpoint({ secure = true } = {}) {
  const cookie = (name, value, maxAge) => cookieHeader(name, value, maxAge, { secure, httpOnly: false });
  return async function handle(request) {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'GET' && request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    const cookies = parseCookies(request.headers.get('cookie'));
    let id = validId(cookies.tb_id) ? cookies.tb_id : null;
    let decision = parseDecision(cookies.tb_c);
    const set = [];
    if (request.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}') || {}; } catch { return new Response('Bad Request', { status: 400 }); }
      if (typeof body.analytics === 'boolean') {
        // A decision: remember it, and keep or delete the ID with it.
        decision = { analytics: body.analytics, ads: body.ads === true };
        set.push(cookie('tb_c', formatDecision(decision), COOKIE_AGE.decision));
        if (!decision.analytics) id = null;
        else id ||= newStableId();
      } else {
        // No decision: a region where consent isn't required (the collector said so to the script).
        id ||= newStableId();
      }
    }
    if (id) set.push(cookie('tb_id', id, COOKIE_AGE.id), cookie('tb_r', '1', 86400));
    else if (cookies.tb_id) set.push(cookie('tb_id', '', 0), cookie('tb_r', '', 0));
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    for (const value of set) headers.append('Set-Cookie', value);
    return new Response(JSON.stringify({ i: id, c: decision ? formatDecision(decision) : null }), { headers });
  };
}
