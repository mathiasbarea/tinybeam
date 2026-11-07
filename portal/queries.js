// What the dashboards show, computed from the events table. Queries stay plain SQL (portable across SQLite,
// D1 and other SQL databases); grouping that needs JSON properties or merging records is done here in
// JavaScript, over at most `limit` rows per query. When a query hits the limit the result says so
// (`truncated`), so a number never hides that it's partial.

const count = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const top = (map, n = 10) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => ({ key, value }));
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

  // Page views of humans, one per page view: the script's record when there is one, else the server's
  // (js unknown) or the noscript pixel's (js off).
  async function pageViews(site, from, to) {
    const list = await rows(`SELECT pv, source, js, path, referrer_type, referrer_host, utm_source, utm_campaign, country, device, browser, os, aid, sid
      FROM $t WHERE ${range} AND kind = 'event' AND traffic = 'human' AND name = 'page_view' ORDER BY received_at LIMIT ${limit + 1}`, [site, from, to]);
    const truncated = list.length > limit;
    const byPv = new Map();
    const views = [];
    for (const row of list.slice(0, limit)) {
      if (!row.pv) { views.push(row); continue; }
      const seen = byPv.get(row.pv);
      if (!seen) { byPv.set(row.pv, row); views.push(row); } else if (row.source === 'script' && seen.source !== 'script') Object.assign(seen, row);
    }
    return { views, truncated };
  }

  async function overview(site, from, to) {
    const { views, truncated } = await pageViews(site, from, to);
    const dims = { pages: new Map(), referrerTypes: new Map(), referrers: new Map(), campaigns: new Map(), countries: new Map(), devices: new Map(), browsers: new Map(), os: new Map(), js: new Map() };
    const visitors = new Set();
    const sessions = new Set();
    for (const v of views) {
      count(dims.pages, v.path);
      // Sources, referrers and campaigns count sessions, from the page view that started each one.
      if (!v.sid || !sessions.has(v.sid)) {
        count(dims.referrerTypes, v.referrer_type || 'direct');
        if (v.referrer_host && v.referrer_type !== 'internal') count(dims.referrers, v.referrer_host);
        if (v.utm_source || v.utm_campaign) count(dims.campaigns, [v.utm_source, v.utm_campaign].filter(Boolean).join(' / '));
      }
      count(dims.countries, v.country || 'Unknown');
      count(dims.devices, v.device || 'Unknown');
      count(dims.browsers, v.browser || 'Unknown');
      count(dims.os, v.os || 'Unknown');
      count(dims.js, v.js || 'on');
      if (v.aid) visitors.add(v.aid);
      if (v.sid) sessions.add(v.sid);
    }
    const engagement = await rows(`SELECT pv, props FROM $t WHERE ${range} AND kind = 'event' AND traffic = 'human' AND name = 'engagement' LIMIT ${limit + 1}`, [site, from, to]);
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
    const events = await rows(`SELECT name, COUNT(*) AS n FROM $t WHERE ${range} AND kind = 'event' AND traffic = 'human' AND name NOT IN ('page_view', 'engagement') GROUP BY name ORDER BY n DESC LIMIT 50`, [site, from, to]);
    const bots = await rows(`SELECT COUNT(*) AS n FROM $t WHERE ${range} AND traffic = 'bot'`, [site, from, to]);
    return {
      truncated: truncated || engagement.length > limit,
      totals: {
        pageViews: views.length,
        visitors: visitors.size, // the anonymous ID changes daily: daily unique visitors, summed
        sessions: sessions.size,
        avgVisibleMs: time.size ? Math.round(totalMs / time.size) : null,
        timedPageViews: time.size,
        bots: bots.length ? Number(bots[0].n) : 0,
      },
      pages: top(dims.pages), referrerTypes: top(dims.referrerTypes), referrers: top(dims.referrers), campaigns: top(dims.campaigns),
      countries: top(dims.countries), devices: top(dims.devices), browsers: top(dims.browsers), os: top(dims.os),
      js: top(dims.js), scrollDepth: [...depth].map(([key, value]) => ({ key: `${key}%`, value })), scrolledPageViews: scroll.size,
      events: events.map(e => ({ key: e.name, value: Number(e.n) })),
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
  async function event(site, name, from, to) {
    const list = await rows(`SELECT pv, sid, props FROM $t WHERE ${range} AND kind = 'event' AND traffic = 'human' AND name = ? LIMIT ${limit + 1}`, [site, from, to, name]);
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
    const total = byCategory.reduce((sum, r) => sum + Number(r.n), 0);
    const aiReferrals = await rows(`SELECT referrer_host AS k, COUNT(*) AS n FROM $t WHERE ${range} AND traffic = 'human' AND name = 'page_view' AND referrer_type = 'ai_assistant' GROUP BY referrer_host ORDER BY n DESC LIMIT 10`, [site, from, to]);
    return {
      total,
      categories: byCategory.map(r => ({ key: r.k || 'unidentified', value: Number(r.n) })),
      bots: byName.map(r => ({ key: r.k, category: r.c, value: Number(r.n), last: Number(r.last) })),
      paths: byPath.map(r => ({ key: r.k, value: Number(r.n) })),
      specialFiles: special.map(r => ({ key: `${r.k} · ${r.b}`, value: Number(r.n) })),
      verified: Object.fromEntries(verified.map(r => [r.k ? 'verified' : 'unverified', Number(r.n)])),
      aiReferrals: aiReferrals.map(r => ({ key: r.k || 'Unknown', value: Number(r.n) })),
    };
  }

  return { overview, event, attributeSummary, bots, pageViews, attributes, resolve };
}
