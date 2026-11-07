// Tinybeam ID endpoint as a Next.js route handler (app/tb/id/route.js). Any server that speaks web-standard
// Request and Response (Remix, SvelteKit, Hono, Deno, Bun, Cloudflare Workers) can mount the same handler
// at /tb/id. The page loads tinybeam-ids.js with data-id="endpoint".
import { createIdEndpoint } from 'tinybeam/collector/endpoint';

const handle = createIdEndpoint();

export const GET = handle;
export const POST = handle;
export const dynamic = 'force-dynamic'; // it reads and sets cookies: never cache it
