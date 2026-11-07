// Cloudflare Workers adapter: the context from request.cf, and storage in D1.

// Client IP, location and Cloudflare's verified-bot signal, and waitUntil so storage writes finish after
// the response is sent.
export const cloudflareContext = (request, ctx) => ({
  ip: request.headers.get('cf-connecting-ip'),
  country: (request.cf && request.cf.country) || null,
  region: (request.cf && request.cf.region) || null,
  city: (request.cf && request.cf.city) || null,
  verifiedBotCategory: (request.cf && request.cf.verifiedBotCategory) || null,
  waitUntil: ctx && ctx.waitUntil ? promise => ctx.waitUntil(promise) : undefined,
});

// A driver for sqlStorage over a D1 binding; inserts of one batch go in a single D1 batch call.
export const d1Driver = db => ({
  exec: sql => db.exec(sql),
  run: (sql, params) => db.prepare(sql).bind(...params).run(),
  batch: (sql, rows) => db.batch(rows.map(row => db.prepare(sql).bind(...row))),
});
