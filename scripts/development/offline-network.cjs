const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const marker = Symbol.for('notionblog.offline-network-guard');
function localHost(host) {
  return typeof host === 'string' && (host.toLowerCase() === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.(?:\d{1,3})){3}$/.test(host));
}
function blocked() { const error = new Error('External server connections are disabled in offline development.'); error.code = 'OFFLINE_NETWORK_BLOCKED'; return error; }
function installOfflineNetworkGuard() {
  if (globalThis[marker]) return;
  globalThis[marker] = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let options = Array.isArray(args[0]) ? args[0] : args;
    const first = options[0];
    if (typeof first === 'object' && first !== null) {
      if (!first.path && !localHost(first.host ?? first.hostname ?? 'localhost')) throw blocked();
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      // A local Unix-domain socket, not a TCP destination.
    } else if (!localHost(typeof options[1] === 'string' ? options[1] : 'localhost')) throw blocked();
    return Reflect.apply(original, this, args);
  };
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  if (originalFetch) globalThis.fetch = function (input, init) {
    try { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['http:', 'https:'].includes(url.protocol) || !localHost(url.hostname)) return Promise.reject(blocked()); }
    catch { return Promise.reject(blocked()); }
    return originalFetch(input, init);
  };
}
module.exports = { installOfflineNetworkGuard };
if (process.env.NOTIONBLOG_DEVELOPMENT_MODE === 'offline') installOfflineNetworkGuard();
