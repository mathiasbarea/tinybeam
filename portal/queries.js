// What the dashboards show, computed from the events table. Queries stay plain SQL (portable across SQLite,
// D1 and other SQL databases); grouping that needs JSON properties or merging records is done here in
// JavaScript, over at most `limit` rows per query. When a query hits the limit the result says so
// (`truncated`), so a number never hides that it's partial.

const count = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const top = (map, n = 10) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => ({ key, value }));
export const OTHER_BOTS = 'Other (never ran the script)';
const parse = text => { try { return text ? JSON.parse(text) : {}; } catch { return {}; } };

export function createQueries(driver, { table = 'tinybeam_events', limit = 100_000, ready = null } = {}) {
  if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  const rows = async (sql, params) => {
    try {
      if (ready) await ready(); // the table may predate newer columns
      return await driver.all(sql.replaceAll('$t', table), params);
    } catch (error) {
      if (/no such table/i.test(String(error && error.message))) return []; // nothing recorded yet
      throw error;
    }
  };
  const range = 'site = ? AND received_at >= ? AND received_at < ?';
  // The period, plus the report's filters: { consent } (a consent state, or "unknown" for records from
  // before consent was recorded). Returns [sql, params].
  const scope = (site, from, to, filter = {}) => {
    if (!filter.consent) return [range, [site, from, to]];
    if (filter.consent === 'unknown') return [`${range} AND consent IS NULL`, [site, from, to]];
    return [`${range} AND consent = ?`, [site, from, to, filter.consent]];
  };

  // Page views of people, one per page view: the script's record when there is one, else the noscript
  // pixel's (js off). A page view only the server saw (`unconfirmed`: the HTML was served, but neither
  // the script nor the pixel reported it) is not counted as a person. Browsers run the script or load
  // the pixel, so these are almost always bots whose user agent looks like a browser; the Bots report
  // shows them as "other". The rare person who left before the script ran is lost with them.
  async function pageViews(site, from, to, filter) {
    const [where, params] = scope(site, from, to, filter);
    const list = await rows(`SELECT pv, source, js, path, referrer_type, referrer_host, utm_source, utm_campaign, country, device, browser, os, aid, sid, consent, id_store, received_at
      FROM $t WHERE ${where} AND kind = 'event' AND traffic = 'human' AND name = 'page_view' ORDER BY received_at LIMIT ${limit + 1}`, params);
    const truncated = list.length > limit;
    const byPv = new Map();
    const merged = [];
    for (const row of list.slice(0, limit)) {
      if (!row.pv) { merged.push(row); continue; }
      const seen = byPv.get(row.pv);
      if (!seen) { byPv.set(row.pv, row); merged.push(row); } else if (row.source !== 'server' && seen.source === 'server') Object.assign(seen, row);
    }
    return { views: merged.filter(v => v.source !== 'server'), unconfirmed: merged.filter(v => v.source === 'server'), truncated };
  }

  async function overview(site, from, to, filter) {
    const [where, params] = scope(site, from, to, filter);
    const { views, unconfirmed, truncated } = await pageViews(site, from, to, filter);
    // Bots aren't filtered by consent, so neither are the unconfirmed page views counted with them.
    const unconfirmedCount = filter && filter.consent ? (await pageViews(site, from, to)).unconfirmed.length : unconfirmed.length;
    const dims = { pages: new Map(), referrerTypes: new Map(), referrers: new Map(), campaigns: new Map(), countries: new Map(), devices: new Map(), browsers: new Map(), os: new Map(), js: new Map(), consent: new Map(), consentSessions: new Map() };
    const visitors = new Set();
    const stableVisitors = new Set(); // recognized across days (a stable ID); the rest only within a day
    const sessions = new Set();
    for (const v of views) {
      count(dims.pages, v.path);
      // Sources, referrers and campaigns count sessions, from the page view that started each one. Page
      // views without a session (refusals, counted without any identifier) count when they come from
      // outside the site, the closest thing to a session's start.
      if (v.sid ? !sessions.has(v.sid) : v.referrer_type !== 'internal') {
        count(dims.referrerTypes, v.referrer_type || 'direct');
        if (v.referrer_host && v.referrer_type !== 'internal') count(dims.referrers, v.referrer_host);
        if (v.utm_source || v.utm_campaign) count(dims.campaigns, [v.utm_source, v.utm_campaign].filter(Boolean).join(' / '));
      }
      count(dims.countries, v.country || 'Unknown');
      count(dims.devices, v.device || 'Unknown');
      count(dims.browsers, v.browser || 'Unknown');
      count(dims.os, v.os || 'Unknown');
      count(dims.js, v.js || 'on');
      count(dims.consent, v.consent || 'unknown');
      if (v.sid && !sessions.has(v.sid)) count(dims.consentSessions, v.consent || 'unknown');
      if (v.aid) visitors.add(v.aid);
      if (v.aid && v.id_store) stableVisitors.add(v.aid);
      if (v.sid) sessions.add(v.sid);
    }
    const engagement = await rows(`SELECT pv, props FROM $t WHERE ${where} AND kind = 'event' AND traffic = 'human' AND name = 'engagement' LIMIT ${limit + 1}`, params);
    const time = new Map();
    const scroll = new Map();
    for (const row of engagement.slice(0, limit)) {
      const p = parse(row.props);
      if (Number.isFinite(p.ms)) count(time, row.pv, p.ms);
      if (Number.isFinite(p.scroll)) scroll.set(row.pv, Math.max(scroll.get(row.pv) || 0, p.scroll));
    }
    const depth = new Map([[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]]);
    for (const value of scroll.values()) count(depth, value);
    const totalMs = [...time.values()].reduce((a, b) => a + b, 0);
    const events = await rows(`SELECT name, COUNT(*) AS n FROM $t WHERE ${where} AND kind = 'event' AND traffic = 'human' AND name NOT IN ('page_view', 'engagement') GROUP BY name ORDER BY n DESC LIMIT 50`, params);
    const bots = await rows(`SELECT COUNT(*) AS n FROM $t WHERE ${range} AND traffic = 'bot'`, [site, from, to]);
    return {
      truncated: truncated || engagement.length > limit,
      totals: {
        pageViews: views.length,
        visitors: visitors.size, // stable IDs, plus daily hashes (daily unique visitors, summed)
        stableVisitors: stableVisitors.size,
        sessions: sessions.size,
        avgVisibleMs: time.size ? Math.round(totalMs / time.size) : null,
        timedPageViews: time.size,
        bots: (bots.length ? Number(bots[0].n) : 0) + unconfirmedCount, // bot requests plus unconfirmed page views
        unconfirmed: unconfirmedCount,
      },
      pages: top(dims.pages), referrerTypes: top(dims.referrerTypes), referrers: top(dims.referrers), campaigns: top(dims.campaigns),
      countries: top(dims.countries), devices: top(dims.devices), browsers: top(dims.browsers), os: top(dims.os),
      js: top(dims.js), scrollDepth: [...depth].map(([key, value]) => ({ key: `${key}%`, value })), scrolledPageViews: scroll.size,
      events: events.map(e => ({ key: e.name, value: Number(e.n) })),
      consent: top(dims.consent), consentSessions: top(dims.consentSessions),
    };
  }

  // The current page, session and user attributes, from the set records (latest value per key wins;
  // null removes it). Returns { page: Map pv -> attrs, session: Map sid -> attrs, user: Map uid -> attrs,
  // userOfSession: Map sid -> uid }.
  async function attributes(site, from, to) {
    const list = await rows(`SELECT name, pv, sid, uid, props FROM $t WHERE ${range} AND kind = 'set' ORDER BY received_at, client_time LIMIT ${limit + 1}`, [site, from, to]);
    const state = { page: new Map(), session: new Map(), user: new Map(), userOfSession: new Map(), truncated: list.length > limit };
    const apply = (map, key, props) => {
      if (!key) return;
      const attrs = map.get(key) || {};
      for (const [k, v] of Object.entries(props)) { if (v === null) delete attrs[k]; else attrs[k] = v; }
      map.set(key, attrs);
    };
    for (const row of list.slice(0, limit)) {
      const props = parse(row.props);
      if (row.name === '$page') apply(state.page, row.pv, props);
      else if (row.name === '$session') apply(state.session, row.sid, props);
      else if (row.name === '$user') {
        if (row.uid) { if (row.sid) state.userOfSession.set(row.sid, row.uid); apply(state.user, row.uid, props); }
      }
    }
    return state;
  }

  // Attributes resolved for one event, as { key: [value, scope] }: event, then page, then session, then
  // user (the first scope that has a key wins).
  const resolve = (state, row, eventProps) => {
    const uid = row.sid ? state.userOfSession.get(row.sid) : null;
    const layers = [['event', eventProps], ['page', row.pv && state.page.get(row.pv)], ['session', row.sid && state.session.get(row.sid)], ['user', uid && state.user.get(uid)]];
    const out = {};
    for (const [scope, attrs] of layers) {
      for (const [key, value] of Object.entries(attrs || {})) if (!(key in out)) out[key] = [value, scope];
    }
    return out;
  };

  // One event, broken down by every attribute that applies to it (its own and the resolved page, session
  // and user attributes, including ones set after the event).
  async function event(site, name, from, to, filter) {
    const [where, params] = scope(site, from, to, filter);
    const list = await rows(`SELECT pv, sid, props FROM $t WHERE ${where} AND kind = 'event' AND traffic = 'human' AND name = ? LIMIT ${limit + 1}`, [...params, name]);
    const state = await attributes(site, from, to);
    const breakdown = new Map();
    for (const row of list.slice(0, limit)) {
      for (const [key, [value, scope]] of Object.entries(resolve(state, row, parse(row.props)))) {
        if (!breakdown.has(key)) breakdown.set(key, { scope, values: new Map() });
        count(breakdown.get(key).values, String(value));
      }
    }
    return {
      total: Math.min(list.length, limit),
      truncated: list.length > limit || state.truncated,
      properties: [...breakdown].map(([key, { scope, values }]) => ({ key, scope, values: top(values, 15) })),
    };
  }

  // Current attributes by scope: how many page views, sessions or users have each value.
  async function attributeSummary(site, from, to) {
    const state = await attributes(site, from, to);
    const summarize = map => {
      const keys = new Map();
      for (const attrs of map.values()) for (const [k, v] of Object.entries(attrs)) {
        if (!keys.has(k)) keys.set(k, new Map());
        count(keys.get(k), String(v));
      }
      return [...keys].map(([key, values]) => ({ key, values: top(values, 10) }));
    };
    return { page: summarize(state.page), session: summarize(state.session), user: summarize(state.user), users: state.user.size, truncated: state.truncated };
  }

  async function bots(site, from, to) {
    const where = `${range} AND traffic = 'bot'`;
    const [byCategory, byName, byPath, special, verified] = await Promise.all([
      rows(`SELECT bot_category AS k, COUNT(*) AS n FROM $t WHERE ${where} GROUP BY bot_category ORDER BY n DESC`, [site, from, to]),
      rows(`SELECT COALESCE(bot_name, 'Unidentified') AS k, bot_category AS c, COUNT(*) AS n, MAX(received_at) AS last FROM $t WHERE ${where} GROUP BY bot_name, bot_category ORDER BY n DESC LIMIT 30`, [site, from, to]),
      rows(`SELECT path AS k, COUNT(*) AS n FROM $t WHERE ${where} GROUP BY path ORDER BY n DESC LIMIT 15`, [site, from, to]),
      rows(`SELECT special_file AS k, COALESCE(bot_name, 'Unidentified') AS b, COUNT(*) AS n FROM $t WHERE ${where} AND special_file IS NOT NULL GROUP BY special_file, bot_name ORDER BY n DESC LIMIT 30`, [site, from, to]),
      rows(`SELECT bot_verified AS k, COUNT(*) AS n FROM $t WHERE ${where} GROUP BY bot_verified`, [site, from, to]),
    ]);
    // Page views no browser confirmed (see pageViews) join the bots as "other".
    const { unconfirmed, truncated } = await pageViews(site, from, to);
    const categories = byCategory.map(r => ({ key: r.k || 'unidentified', value: Number(r.n) }));
    const botList = byName.map(r => ({ key: r.k, category: r.c, value: Number(r.n), last: Number(r.last) }));
    const paths = new Map(byPath.map(r => [r.k, Number(r.n)]));
    if (unconfirmed.length) {
      categories.push({ key: 'other', value: unconfirmed.length });
      botList.push({ key: OTHER_BOTS, category: 'other', value: unconfirmed.length, last: unconfirmed.reduce((max, v) => Math.max(max, Number(v.received_at)), 0) });
      for (const v of unconfirmed) count(paths, v.path);
    }
    const byValue = (a, b) => b.value - a.value;
    const total = categories.reduce((sum, r) => sum + r.value, 0);
    const aiReferrals = await rows(`SELECT referrer_host AS k, COUNT(*) AS n FROM $t WHERE ${range} AND traffic = 'human' AND name = 'page_view' AND referrer_type = 'ai_assistant' GROUP BY referrer_host ORDER BY n DESC LIMIT 10`, [site, from, to]);
    return {
      total,
      truncated,
      categories: categories.sort(byValue),
      bots: botList.sort(byValue).slice(0, 30),
      paths: top(paths, 15),
      specialFiles: special.map(r => ({ key: `${r.k} · ${r.b}`, value: Number(r.n) })),
      verified: Object.fromEntries(verified.map(r => [r.k ? 'verified' : 'unverified', Number(r.n)])),
      aiReferrals: aiReferrals.map(r => ({ key: r.k || 'Unknown', value: Number(r.n) })),
    };
  }

  // How the site's page views kept the stable ID lately (id_store), for the installation check.
  async function installCheck(site, from, to) {
    const list = await rows(`SELECT id_store AS k, COUNT(*) AS n FROM $t WHERE ${range} AND kind = 'event' AND source = 'script' AND name = 'page_view' AND consent IN ('granted', 'not_required') GROUP BY id_store`, [site, from, to]);
    return Object.fromEntries(list.map(r => [r.k || 'none', Number(r.n)]));
  }

  return { overview, event, attributeSummary, bots, pageViews, attributes, resolve, installCheck };
}
