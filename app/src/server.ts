import { serve } from '@hono/node-server';
import { createApp } from './app';
import { fakeDeps } from './testing/fakes';

/**
 * `pnpm dev`: the API on http://127.0.0.1:8787/api/v1 with in-memory stores, sample passages and a scripted answer,
 * so the chat panel and the stream can be developed without AWS. Every request runs as a fixed local caller.
 *
 *   curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
 *     -d '{"query":"How do I add a site?"}' http://127.0.0.1:8787/api/v1/chat
 */
const deps = fakeDeps({ now: undefined });
const app = createApp({
  ...deps,
  clock: () => new Date(),
  corsAllowOrigins: ['http://127.0.0.1:8000', 'http://localhost:8000'],
  devCaller: { id: 'local-reader', clientId: 'local' },
  log: (entry) => console.log(JSON.stringify(entry)),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
  console.log(`OrcaSonar (local, in-memory) on http://127.0.0.1:${port}/api/v1`)
);
