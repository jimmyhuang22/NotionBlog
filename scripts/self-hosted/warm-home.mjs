import { createServer, get } from 'node:http';
import { performance } from 'node:perf_hooks';

const paths = ['/api/content/version', '/'];

/** Use the normal routes and cache guards before admitting visitors. This only
 * warms the first home page; it does not fetch images, scripts or other sections. */
export async function warmSelfHostedHome(handle, env, { timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  if (env.SELF_HOSTED_DEPLOYMENT !== 'public-website' || env.PUBLIC_CONTENT_CACHE !== 'tagged-v1')
    return { outcome: 'skipped' };
  const started = performance.now();
  let server;
  try {
    const origin = new URL(env.SITE_URL);
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw Error('WARMUP_ORIGIN');
    const signal = AbortSignal.timeout(timeoutMs);
    server = createServer((request, response) => {
      Promise.resolve().then(() => handle(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    // The temporary port is loopback-only, even when the public listener binds
    // all interfaces. Host is configuration, never an outbound destination.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    let bytes = 0;
    for (const path of paths) {
      await new Promise((resolve, reject) => {
        const request = get({ hostname: '127.0.0.1', port, path, signal, agent: false,
          headers: { Host: origin.host, 'X-Forwarded-Proto': 'https' } }, response => {
          const json = path !== '/';
          const type = json ? 'application/json' : 'text/html';
          if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith(type)) {
            response.destroy(); reject(Error('WARMUP_RESPONSE')); return;
          }
          const chunks = [];
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { response.destroy(Error('WARMUP_SIZE')); return; }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('aborted', () => reject(Error('WARMUP_ABORTED')));
          response.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              if (json) {
                const result = JSON.parse(body);
                if (result?.version !== 1 || typeof result.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision))
                  throw Error('WARMUP_DATA');
              // The homepage can return 200 while streaming a retry placeholder.
              // Only the successful server-side feed read emits this inert marker.
              } else if (!body.includes('<template data-home-feed-ready="true"></template>')) throw Error('WARMUP_DATA');
              resolve();
            } catch { reject(Error('WARMUP_DATA')); }
          });
        });
        request.on('error', reject);
      });
    }
    return { outcome: 'ready', durationMs: Math.round(performance.now() - started), bytes };
  } catch {
    // Database outages keep their existing bounded retry UI. Do not log URLs,
    // driver errors, configuration or returned content, or keep retrying here.
    return { outcome: 'unavailable', durationMs: Math.round(performance.now() - started) };
  } finally {
    if (server?.listening) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
}
