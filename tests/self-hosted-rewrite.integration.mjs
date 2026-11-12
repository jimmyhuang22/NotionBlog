import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createSelfHostedNextApp } from '../scripts/self-hosted/next-app.mjs';

// Run after the ordinary offline build, not against a protected runtime profile.
assert.equal(process.env.NOTIONBLOG_DEVELOPMENT_MODE, 'offline');
assert.equal(process.env.CONTENT_PROVIDER, 'mock');

function read(port, method, path, protocol) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: {
      Host: 'site.example.invalid',
      'X-Forwarded-Host': 'site.example.invalid',
      'X-Forwarded-Proto': protocol,
      Connection: 'close',
    } }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(parts).toString('utf8') }));
    });
    req.setTimeout(10_000, () => req.destroy(Error('rewrite request timed out')));
    req.on('error', reject);
    req.end();
  });
}

test('built self-hosted app keeps disabled-section rewrites internal behind an HTTPS proxy', { timeout: 60_000 }, async () => {
  let handle;
  const appErrors = [];
  const originalError = console.error;
  console.error = (...args) => { appErrors.push(args.map(String).join(' ')); originalError(...args); };
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      appErrors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  let app;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port, address } = server.address();
    assert.equal(address, '127.0.0.1');
    app = createSelfHostedNextApp({ dir: process.cwd(), port });
    await app.prepare();
    handle = app.getRequestHandler();
    for (const protocol of ['https', 'http']) {
      for (const path of ['/blog', '/projects']) {
        for (const method of ['HEAD', 'GET']) {
          const response = await read(port, method, path, protocol);
          assert.equal(response.status, 404, `${protocol} ${method} ${path}`);
          assert.equal(response.headers.location, undefined, 'must not redirect the visitor');
          assert.match(response.headers['cache-control'], /no-store/);
          assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
          assert.equal(response.headers['x-middleware-rewrite'], '/content-not-found', 'must be a local rewrite');
          if (method === 'HEAD') assert.equal(response.body, '');
          else {
            assert.ok(response.body.includes('<h1>这一页是空的</h1>'), 'render the actual not-found page');
            assert.match(response.body, /<nav[ >]/, 'render the real error page with site navigation');
          }
        }
      }
    }
    const enabled = await read(port, 'GET', '/status', 'https');
    assert.equal(enabled.status, 200);
    assert.equal(enabled.headers['x-middleware-rewrite'], undefined);
    assert.match(enabled.body, /status-page/);
    assert.deepEqual(appErrors, [], 'no TLS/proxy/application errors');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app?.close();
    console.error = originalError;
  }
});
