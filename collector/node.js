// Node.js adapter: serves a collector over node:http, and storage for a JSON Lines file or SQLite
// (node:sqlite, built into Node.js 22.5 and later).
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { sqlStorage } from './storage.js';

// A web-standard Request from a Node.js request, plus the context the collector needs. Behind a proxy
// or load balancer, `trustProxy` takes the client IP from X-Forwarded-For; otherwise it is the socket's.
export async function fromNode(req, { trustProxy = false } = {}) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const proto = trustProxy && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'].split(',')[0] : 'http';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
  const request = new Request(`${proto}://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body });
  const forwarded = trustProxy && req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  return { request, context: { ip } };
}

export async function toNode(response, res) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

// Runs the collector as a standalone server. Resolves with the node:http server once it listens.
export function serve(collector, { port = 8787, host, trustProxy = false } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const { request, context } = await fromNode(req, { trustProxy });
      await toNode(await collector.handle(request, context), res);
    } catch (error) {
      console.error('tinybeam:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

// One JSON object per line, appended to `path`.
export function jsonlStorage(path) {
  return { write: batch => appendFile(path, batch.map(record => JSON.stringify(record) + '\n').join('')) };
}

// SQLite through node:sqlite. `path` is a file, or ':memory:'.
export async function sqliteStorage(path, options) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  return sqlStorage({
    exec: sql => db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(...params),
    db,
  }, options);
}
