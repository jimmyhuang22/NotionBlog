import net from 'node:net';
import http from 'node:http';

const integer = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
export function validatePlan(plan) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'destinations,maxConnections,maxReceivedBytes,maxRequests,paths,version' || plan.version !== 1 ||
      !integer(plan.maxRequests, 20) || !integer(plan.maxConnections, 32) || !integer(plan.maxReceivedBytes, 16 * 1024 * 1024) ||
      !Array.isArray(plan.paths) || !plan.paths.length || plan.paths.length > 20 ||
      !Array.isArray(plan.destinations) || !plan.destinations.length || plan.destinations.length > 8) throw new Error('Invalid bounded cloud plan.');
  if (plan.paths.some(path => typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') ||
      /[\x00-\x20\x7f\\#]/.test(path) || new URL(path, 'http://fixture.invalid').pathname.startsWith('/_next/')) ||
      new Set(plan.paths).size !== plan.paths.length || plan.destinations.some(item => !item || Object.keys(item).sort().join(',') !== 'host,port' ||
        typeof item.host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(item.host) || !integer(item.port, 65535)) ||
      new Set(plan.destinations.map(item => `${item.host}:${item.port}`)).size !== plan.destinations.length) throw new Error('Invalid cloud samples or destinations.');
  return plan;
}
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});

/** One parent owns counters for all Next workers. Bodies/URLs/credentials are never logged. */
export async function createCloudSession(plan, onStop = () => {}) {
  validatePlan(plan);
  const servers = [], sockets = new Set();
  const state = { requests: 0, connections: 0, receivedBytes: 0, stopped: false, reason: null };
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  function stop(reason) {
    if (state.stopped) return;
    state.stopped = true; state.reason = reason;
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    onStop(reason);
  }
  const mapping = [];
  try {
    for (const destination of plan.destinations) {
      const server = net.createServer(local => {
        track(local);
        if (state.stopped) { local.destroy(); return; }
        if (state.connections >= plan.maxConnections) { stop('connection_limit'); return; }
        state.connections++;
        const remote = track(net.connect({ host: destination.host, port: destination.port }));
        remote.on('error', () => stop('upstream_error'));
        local.pipe(remote);
        remote.on('data', chunk => {
          // Count wire bytes, including TLS/PG framing. The overflow chunk may
          // already have reached this machine; never call this an exact billing cap.
          state.receivedBytes += chunk.length;
          if (state.receivedBytes >= plan.maxReceivedBytes) { stop('byte_limit'); return; }
          if (!local.write(chunk)) remote.pause();
        });
        local.on('drain', () => remote.resume());
        remote.on('end', () => local.end());
        local.once('close', () => remote.destroy()); remote.once('close', () => local.destroy());
      });
      servers.push(server);
      mapping.push({ ...destination, localPort: await listen(server) });
    }
  } catch (error) { stop('startup_error'); throw error; }
  return {
    mapping, state, stop,
    async gateway(port, nextPort) {
      const server = http.createServer((request, response) => {
        if (state.stopped) { response.writeHead(410).end(); return; }
        // Static JS/CSS cannot execute a content route; all page/API/media/RSC
        // requests, including speculative prefetch, must match the fixed list.
        const staticAsset = request.method === 'GET' && /^\/_next\/static\/[A-Za-z0-9_./%~-]+(?:\?[A-Za-z0-9_.=&%~-]{1,256})?$/.test(request.url ?? '') &&
          !/\.\.|%2e|%2f|%5c/i.test(request.url);
        if (!staticAsset && (request.method !== 'GET' || !plan.paths.includes(request.url))) { response.writeHead(403).end('Unplanned sample.'); return; }
        if (!staticAsset) {
          if (state.requests >= plan.maxRequests) { response.writeHead(429).end(); stop('request_limit'); return; }
          state.requests++;
        }
        // Do not forward attacker-supplied RSC/middleware headers or credentials.
        const upstream = http.request({ host: '127.0.0.1', port: nextPort, path: request.url, method: 'GET',
          headers: { host: `127.0.0.1:${port}`, accept: staticAsset ? '*/*' : 'text/html,application/json,image/*' } }, result => {
          response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.once('close', () => upstream.destroy()); upstream.end();
      });
      server.on('connection', track); servers.push(server);
      await listen(server, port);
    },
  };
}

export async function unusedLocalPort() {
  const server = net.createServer(); const port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}
