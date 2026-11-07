// Tinybeam ID endpoint for Node.js servers built on node:http (Express, Fastify, Koa…): mounts the
// web-standard handler at /tb/id. The page loads tinybeam-ids.js with data-id="endpoint".
import express from 'express';
import { createIdEndpoint } from 'tinybeam/collector/endpoint';
import { fromNode, toNode } from 'tinybeam/collector/node';

const handle = createIdEndpoint();
const app = express();

app.all('/tb/id', async (req, res) => {
  const { request } = await fromNode(req, { trustProxy: true }); // behind your proxy, for the https scheme
  await toNode(await handle(request), res);
});

app.listen(3000);
