// Storage adapters. A storage is any object with `write(records)` returning a promise. Records are flat
// objects with the fields in COLUMNS; `props` and `cap` are objects (adapters serialize them as needed).

export const COLUMNS = {
  received_at: 'INTEGER', // ms since epoch, collector clock
  client_time: 'INTEGER', // ms since epoch, browser clock
  site: 'TEXT',
  kind: 'TEXT', // event | bot
  source: 'TEXT', // script | server | noscript
  js: 'TEXT', // on | off | unknown
  name: 'TEXT',
  pv: 'TEXT',
  aid: 'TEXT',
  sid: 'TEXT',
  url: 'TEXT',
  host: 'TEXT',
  path: 'TEXT',
  title: 'TEXT',
  referrer: 'TEXT',
  referrer_host: 'TEXT',
  referrer_type: 'TEXT',
  utm_source: 'TEXT',
  utm_medium: 'TEXT',
  utm_campaign: 'TEXT',
  utm_term: 'TEXT',
  utm_content: 'TEXT',
  utm_id: 'TEXT',
  click_id_type: 'TEXT',
  click_id: 'TEXT',
  props: 'TEXT', // JSON
  device: 'TEXT',
  browser: 'TEXT',
  browser_version: 'TEXT',
  os: 'TEXT',
  os_version: 'TEXT',
  country: 'TEXT',
  region: 'TEXT',
  city: 'TEXT',
  language: 'TEXT',
  screen_w: 'INTEGER',
  screen_h: 'INTEGER',
  viewport_w: 'INTEGER',
  viewport_h: 'INTEGER',
  tz: 'TEXT',
  tx: 'TEXT',
  cap: 'TEXT', // JSON
  automation: 'INTEGER', // 1 when navigator.webdriver was true
  traffic: 'TEXT', // human | bot
  bot_name: 'TEXT',
  bot_category: 'TEXT',
  bot_verified: 'INTEGER',
  status: 'INTEGER', // HTTP status, for server-side records
  special_file: 'TEXT', // robots.txt | sitemap | llms.txt | markdown, for server-side records
};

// Keeps records in an array. For tests and trying things out.
export function memoryStorage() {
  const records = [];
  return { records, write: async batch => { records.push(...batch); } };
}

const toRow = record => Object.keys(COLUMNS).map(key => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
});

// Any SQL database, through a minimal driver, sync or async, with `?` placeholders:
//   { exec(sql), run(sql, params), all(sql, params) -> rows, batch?(sql, rowsOfParams) }
// Event storage needs exec and run; the portal also needs all. Drivers for SQLite (node:sqlite) and
// Cloudflare D1 are in node.js and cloudflare.js; for other databases, wrap your client the same way.
export function sqlStorage(driver, { table = 'tinybeam_events' } = {}) {
  if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  const columns = Object.keys(COLUMNS);
  const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  let ready;
  const init = () => (ready ??= Promise.resolve(driver.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (${columns.map(c => `${c} ${COLUMNS[c]}`).join(', ')});\n` +
    `CREATE INDEX IF NOT EXISTS ${table}_site_time ON ${table} (site, received_at);`,
  )));
  return {
    driver,
    async write(batch) {
      await init();
      if (driver.batch) await driver.batch(insert, batch.map(toRow));
      else for (const record of batch) await driver.run(insert, toRow(record));
    },
  };
}
