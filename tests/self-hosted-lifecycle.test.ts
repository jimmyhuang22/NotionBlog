import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { drainSelfHostedServer } from '../scripts/self-hosted/lifecycle.mjs';

test('self-hosted shutdown waits for an in-flight HTTP response and Next callbacks before ending readers', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const server = createServer(async (_request, response) => {
    enter(); await held;
    response.on('finish', () => events.push('response-finished'));
    response.end('complete');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const response = fetch(`http://127.0.0.1:${address.port}`);
    await entered;
    const drained = drainSelfHostedServer(server, { close: async () => { events.push('next-closed'); } }, async () => { events.push('pools-closed'); return 2; });
    assert.deepEqual(events, []);
    release(); assert.equal(await (await response).text(), 'complete');
    assert.equal(await drained, 2);
    assert.deepEqual(events, ['response-finished', 'next-closed', 'pools-closed']);
  } finally { release(); server.closeAllConnections(); server.close(); }
});
test('failed Next cleanup still closes readers after HTTP drain and reports failure', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  await assert.rejects(drainSelfHostedServer(server, { close: async () => { throw Error('fixture'); } },
    async () => { closed = true; return 1; }), /SELF_HOSTED_FRAMEWORK_CLOSE/);
  assert.equal(closed, true);
});
