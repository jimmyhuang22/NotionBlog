import { createServer } from 'node:http';
import next from 'next';
import context from './context.cjs';
import { verifySelfHostedReaders } from './reader.ts';
import { drainSelfHostedServer } from './lifecycle.mjs';
import { selfHostedDisplayStore } from '../../src/server/self-hosted-media/runtime.ts';

if (context.configureSelfHostedEnvironment(process.env) !== 'self-hosted') throw Error('SELF_HOSTED_CONTEXT_REQUIRED');
let app, server, stopping;
try {
  await verifySelfHostedReaders(process.env);
  await selfHostedDisplayStore()?.verifyRoot();
  app = next({ dev: false, dir: process.cwd(), hostname: process.env.HOSTNAME, port: Number(process.env.PORT) });
  await app.prepare();
  const handle = app.getRequestHandler();
  server = createServer((request, response) => {
    if (stopping) { response.writeHead(503).end(); return; }
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('upgrade', app.getUpgradeHandler());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORT), process.env.HOSTNAME, resolve); });
  console.log('self_hosted_ready', JSON.stringify({ host: process.env.HOSTNAME, port: Number(process.env.PORT), indexing: false }));
  const stop = () => {
    if (stopping) return;
    const timer = setTimeout(() => { server.closeAllConnections(); console.error('SELF_HOSTED_DRAIN_TIMEOUT'); process.exit(1); }, 30000);
    timer.unref();
    stopping = drainSelfHostedServer(server, app, context.closeSelfHostedPools).then(pools => {
      clearTimeout(timer); console.log('self_hosted_stopped', JSON.stringify({ pools }));
    }).catch(() => {
      // Keep the deadline armed if a failed cleanup leaves referenced handles.
      console.error('SELF_HOSTED_SHUTDOWN_FAILED'); process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch {
  console.error('SELF_HOSTED_START_FAILED');
  await app?.close().catch(() => {});
  await context.closeSelfHostedPools().catch(() => {});
  process.exitCode = 1;
}
