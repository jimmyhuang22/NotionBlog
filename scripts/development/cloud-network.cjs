const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const marker = Symbol.for('notionblog.cloud-network-guard');
const local = host => ['localhost', '::1', '[::1]'].includes(host) || /^127(?:\.\d{1,3}){3}$/.test(host);

function installCloudNetworkGuard(mapping) {
  if (globalThis[marker]) return;
  if (!Array.isArray(mapping) || !mapping.length || mapping.some(item => !item || typeof item.host !== 'string' ||
      !Number.isInteger(item.port) || !Number.isInteger(item.localPort) || item.localPort < 1)) throw new Error('Cloud relay configuration required.');
  globalThis[marker] = true;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    if (first && typeof first === 'object' && first.path) throw Object.assign(new Error('Cloud Unix sockets disabled.'), { code: 'CLOUD_DESTINATION_BLOCKED' });
    const options = typeof first === 'object' && first !== null ? first : { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' };
    const host = String(options.host ?? options.hostname ?? 'localhost').toLowerCase(), port = Number(options.port);
    const target = mapping.find(item => item.host === host && item.port === port);
    if (!target) {
      if (local(host)) return Reflect.apply(connect, this, args);
      throw Object.assign(new Error('Unplanned cloud destination.'), { code: 'CLOUD_DESTINATION_BLOCKED' });
    }
    const callback = normalized.find(arg => typeof arg === 'function');
    const redirected = { ...options, host: '127.0.0.1', port: target.localPort, family: 4, autoSelectFamily: false };
    // TLS retains the original servername/certificate verification in its caller.
    delete redirected.lookup; delete redirected.hostname;
    return Reflect.apply(connect, this, callback ? [redirected, callback] : [redirected]);
  };
  syncBuiltinESMExports();
}
module.exports = { installCloudNetworkGuard };
if (process.env.NOTIONBLOG_DEVELOPMENT_MODE === 'cloud') {
  installCloudNetworkGuard(JSON.parse(process.env.NOTIONBLOG_CLOUD_RELAY ?? 'null'));
}
