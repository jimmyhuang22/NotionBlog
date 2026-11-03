import test from 'node:test';
import assert from 'node:assert/strict';
import { warmSelfHostedHome } from '../scripts/self-hosted/warm-home.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const env = { SELF_HOSTED_DEPLOYMENT: 'public-website', PUBLIC_CONTENT_CACHE: 'tagged-v1', SITE_URL: 'https://blog.example.invalid' };
type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const page: Handler = (request, response) => {
  response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'application/json');
  response.end(request.url === '/' ? '<main><template data-home-feed-ready="true"></template><img src="/must-not-fetch"></main>'
    : JSON.stringify({ version: 1, revision: 'a'.repeat(64) }));
};

test('startup warms the guarded first page and its render on loopback, without fetching page assets', async () => {
  const calls: string[] = [];
  const result = await warmSelfHostedHome((request: IncomingMessage, response: ServerResponse) => {
    assert.equal(request.socket.localAddress, '127.0.0.1');
    assert.equal(request.headers.host, 'blog.example.invalid');
    assert.equal(request.headers['x-forwarded-proto'], 'https');
    calls.push(request.url!); page(request, response);
  }, env);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(calls, ['/api/content/version', '/']);
  assert.ok(result.bytes! > 0);
});

test('private/offline and cache-disabled runtimes do not perform warmup reads', async () => {
  for (const disabled of [{ ...env, SELF_HOSTED_DEPLOYMENT: 'private' }, { ...env, PUBLIC_CONTENT_CACHE: 'off' }, {}])
    assert.deepEqual(await warmSelfHostedHome(() => assert.fail('No request'), disabled), { outcome: 'skipped' });
});

test('startup does not follow redirects, retry failures or accept an error as warm data', async () => {
  for (const [status, type, body] of [[503, 'application/json', '{"error":{"code":"CONTENT_UNAVAILABLE"}}'],
    [302, 'text/html', 'redirect'], [200, 'text/html', 'retry'], [200, 'application/json', '{"error":{}}'],
    [200, 'application/json', '{'], [200, 'application/json', JSON.stringify({ data: { items: Array(17).fill(null) } })]] as const) {
    let requests = 0;
    const result = await warmSelfHostedHome((_request: IncomingMessage, response: ServerResponse) => {
      requests++; response.writeHead(status, { 'Content-Type': type, Location: 'https://must-not-follow.invalid' }); response.end(body);
    }, env);
    assert.equal(result.outcome, 'unavailable'); assert.equal(requests, 1);
    assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'outcome']);
  }
});

test('failed homepage rendering is reported even after the data request succeeds', async () => {
  let requests = 0;
  const result = await warmSelfHostedHome((request: IncomingMessage, response: ServerResponse) => {
    requests++;
    if (request.url === '/') throw Error('private-config');
    page(request, response);
  }, env);
  assert.equal(result.outcome, 'unavailable'); assert.equal(requests, 2);
  assert.ok(!JSON.stringify(result).includes('private-config'));
});

test('a successful version check followed by a streamed 200 retry page is not warm data', async () => {
  const result = await warmSelfHostedHome((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== '/') { page(request, response); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<main><div role="status">Retry</div></main>');
  }, env);
  assert.equal(result.outcome, 'unavailable');
});

test('slow or oversized responses release the temporary listener and let startup continue', async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const slow = await warmSelfHostedHome((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    response.on('close', closed);
  }, env, { timeoutMs: 80 });
  assert.equal(slow.outcome, 'unavailable'); await disconnected;
  const large = await warmSelfHostedHome((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(' '.repeat(128));
  }, env, { maxBytes: 32 });
  assert.equal(large.outcome, 'unavailable');
});
