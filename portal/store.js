// The portal's configuration (users, sessions, sites) in the same SQL database as the events, through the
// same driver (collector/storage.js).
import { RETENTION_MONTHS, newSiteId } from '../collector/index.js';
import { addColumns } from '../collector/storage.js';
import { hashToken, newToken } from './auth.js';

const SESSION_DAYS = 30;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS tb_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS tb_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS tb_sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);',
].join('\n');

// `settings` (JSON) holds the site's consent settings (`consent`, collector/consent.js; missing keys take the
// defaults), where it is hosted (`host`, portal/install.js) and how many months its data is kept
// (`retention`, collector/index.js).
const parse = text => { try { return text ? JSON.parse(text) : {}; } catch { return {}; } };
const siteFromRow = row => row && { id: row.id, name: row.name, origins: JSON.parse(row.origins), paused: Boolean(row.paused), created_at: row.created_at, ...settingsOf(row) };
const settingsOf = row => { const s = parse(row.settings); return { consent: s.consent || {}, host: s.host || null, retention: s.retention || RETENTION_MONTHS }; };

export function createStore(driver, { now = Date.now } = {}) {
  let ready;
  const init = () => (ready ??= (async () => {
    await driver.exec(SCHEMA);
    await addColumns(driver, 'tb_sites', [['settings', 'TEXT']]);
  })());
  const all = async (sql, params = []) => { await init(); return driver.all(sql, params); };
  const one = async (sql, params) => (await all(sql, params))[0] || null;
  const run = async (sql, params = []) => { await init(); return driver.run(sql, params); };
  const getSite = async id => siteFromRow(await one('SELECT * FROM tb_sites WHERE id = ?', [id]));

  return {
    async hasUsers() {
      return Boolean(await one('SELECT id FROM tb_users LIMIT 1'));
    },
    async createUser(email, passwordHash, role = 'owner') {
      const id = crypto.randomUUID();
      await run('INSERT INTO tb_users (id, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)', [id, email, passwordHash, role, now()]);
      return { id, email, role };
    },
    findUserByEmail: email => one('SELECT * FROM tb_users WHERE email = ?', [email]),

    async createSession(userId) {
      const token = newToken();
      await run('INSERT INTO tb_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [await hashToken(token), userId, now() + SESSION_DAYS * 864e5]);
      return { token, maxAge: SESSION_DAYS * 86400 };
    },
    async userForSession(token) {
      if (!token) return null;
      return one('SELECT u.id, u.email, u.role FROM tb_sessions s JOIN tb_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', [await hashToken(token), now()]);
    },
    async deleteSession(token) {
      if (token) await run('DELETE FROM tb_sessions WHERE token_hash = ?', [await hashToken(token)]);
    },

    listSites: async () => (await all('SELECT * FROM tb_sites ORDER BY created_at')).map(siteFromRow),
    getSite,
    async createSite({ name, origins }) {
      const site = { id: newSiteId(), name, origins, paused: false, created_at: now() };
      await run('INSERT INTO tb_sites (id, name, origins, paused, created_at) VALUES (?, ?, ?, 0, ?)', [site.id, name, JSON.stringify(origins), site.created_at]);
      return site;
    },
    async updateSite(id, { name, origins, paused }) {
      await run('UPDATE tb_sites SET name = ?, origins = ?, paused = ? WHERE id = ?', [name, JSON.stringify(origins), paused ? 1 : 0, id]);
    },
    // Changes part of the site's settings ({ consent } or { host }), keeping the rest.
    async updateSettings(id, changes) {
      const row = await one('SELECT settings FROM tb_sites WHERE id = ?', [id]);
      await run('UPDATE tb_sites SET settings = ? WHERE id = ?', [JSON.stringify({ ...parse(row && row.settings), ...changes }), id]);
    },
    // Removes the site and every event recorded for it.
    async deleteSite(id, eventsTable = 'tinybeam_events') {
      await run('DELETE FROM tb_sites WHERE id = ?', [id]);
      try { await run(`DELETE FROM ${eventsTable} WHERE site = ?`, [id]); } catch { /* no events table yet */ }
    },
    // What the collector needs (its `sites` option): an active site, or null.
    async activeSite(id) {
      const site = await getSite(id);
      return site && !site.paused ? site : null;
    },
  };
}
