import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const cacheDir = await mkdtemp(join(tmpdir(), 'harness-component-vite-'));
const server = await createServer({
  root: process.cwd(), configFile: false, cacheDir,
  plugins: [{
    name: 'harness-component-fixture',
    configureServer(server) {
      server.middlewares.use('/__harness', async (_request, response) => {
        const html = await server.transformIndexHtml('/__harness', `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module" src="/src/features/harness/tests/browser-entry.tsx"></script></body></html>`);
        response.setHeader('Content-Type', 'text/html');
        response.end(html);
      });
    },
  }, react()],
  server: { host: '127.0.0.1', port: 4384, strictPort: true },
});
await server.listen();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
