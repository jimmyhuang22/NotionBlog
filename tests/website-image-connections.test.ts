import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, Agent, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebsiteImageDownloader, wrapWebsiteImageResponse } from '../scripts/website-sync/download.ts';
import { createWebsiteImageCache } from '../scripts/website-sync/image-cache.ts';
import { DEMO_PNG } from '../scripts/notion-sync/demo.ts';
import type { ImageResponse } from '../scripts/notion-sync/download.ts';

test('native 304 responses retain one verified connection across repeated cache checks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'website-native-304-'))); await chmod(root, 0o700);
  const cache = await createWebsiteImageCache({ directory: join(root, 'cache') });
  let connections = 0, calls = 0; const reused: boolean[] = [];
  const server = createServer((req, res) => {
    res.setHeader('etag', '"fixture"'); res.setHeader('content-type', 'image/png');
    if (req.headers['if-none-match']) { res.statusCode = 304; res.end(); } else res.end(DEMO_PNG);
  });
  server.on('connection', () => connections++);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, maxTotalSockets: 4, timeout: 5000 });
  const download = createWebsiteImageDownloader({ resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    // Isolated loopback transport uses the same IncomingMessage adapter as HTTPS.
    // Production keeps its checked-IP, Host, SNI and certificate verification.
    request: async (_url, _address, signal, headers) => new Promise<ImageResponse>((resolve, reject) => {
      calls++;
      const req = request({ hostname: '127.0.0.1', port, agent, headers, signal }, response => {
        reused.push(req.reusedSocket); resolve(wrapWebsiteImageResponse(response));
      });
      req.once('error', reject); req.end();
    }),
  }, { cache });
  try {
    for (let i = 0; i < 6; i++) assert.deepEqual((await download('https://images.example.test/image.png')).bytes, DEMO_PNG);
    assert.equal(calls, 6); assert.equal(connections, 1);
    assert.deepEqual(reused, [false, true, true, true, true, true]);
    assert.equal(download.statistics().revalidatedImages, 5);
    assert.equal(download.statistics().receivedBodyBytes, DEMO_PNG.length);
  } finally {
    agent.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
