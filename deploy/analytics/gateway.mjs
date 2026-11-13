import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Private upstream, authenticated site relays, and the normal Umami login UI. No access logging. */
export function createAnalyticsGateway({ secret, upstreamPort = 3105 }) {
  if (!/^[a-f0-9]{64}$/.test(secret) || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw Error('ANALYTICS_GATEWAY_CONFIG_INVALID');
  }
  const expected = Buffer.from(secret);
  const server = http.createServer((request, response) => {
    const stop = status => { if (!response.headersSent) response.writeHead(status, { 'Cache-Control': 'no-store' }); response.end(); };
    let path;
    try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { stop(400); return; }
    const collect = path === '/collect';
    // Browser telemetry uses the website's sanitized relay, never Umami's raw collector.
    if (/^\/api\/send(?:\/|$)/.test(path)) { stop(404); return; }
    if (collect) {
      const key = Buffer.from(String(request.headers['x-analytics-key'] ?? ''));
      if (request.method !== 'POST' || key.length !== expected.length || !timingSafeEqual(key, expected) ||
          !isIP(String(request.headers['x-analytics-client-ip'] ?? ''))) { stop(403); return; }
    }
    const outgoing = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (!hopHeaders.has(key) && !key.startsWith('x-analytics-') && !key.startsWith('cf-') &&
          !key.startsWith('x-forwarded-') && !key.startsWith('x-vercel-') &&
          !key.startsWith('cloudfront-') && !key.startsWith('eo-') && key !== 'x-real-ip' && key !== 'x-umami-cache') outgoing[key] = value;
    }
    outgoing['x-forwarded-proto'] = 'https';
    if (collect) {
      outgoing['x-analytics-client-ip'] = request.headers['x-analytics-client-ip'];
      if (request.headers['x-umami-cache']) outgoing['x-umami-cache'] = request.headers['x-umami-cache'];
      delete outgoing.cookie;
      delete outgoing.authorization;
    }
    const maxBytes = collect ? 8192 : 1024 * 1024;
    if (Number(request.headers['content-length']) > maxBytes) { stop(413); return; }
    // Buffer the bounded request before forwarding: an oversized partial event must never reach Umami.
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { stop(413); request.destroy(); } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
        path: collect ? '/api/send' : request.url, method: request.method, headers: outgoing,
        timeout: collect ? 2500 : 15000 }, incoming => {
        const safe = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hopHeaders.has(key)));
        response.writeHead(incoming.statusCode ?? 502, safe);
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => stop(502));
      response.on('close', () => upstream.destroy());
      upstream.end(Buffer.concat(chunks));
    });
    request.on('error', () => stop(400));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAnalyticsGateway({ secret: process.env.ANALYTICS_RELAY_SECRET,
    upstreamPort: Number(process.env.UMAMI_PORT ?? 3105) });
  server.listen(Number(process.env.PORT ?? 3106), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
}
