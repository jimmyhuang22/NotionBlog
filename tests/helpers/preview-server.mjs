import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createServer as realCreateServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'preview-server-'));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Math.floor(Date.now() / 1000);
const config = { previewHost: 'preview.example.test', issuer: 'https://example.cloudflareaccess.com', audience: 'a'.repeat(64), expiresAt: now + 600, keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256' }] };
const configPath = join(directory, 'access.json');
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
Object.assign(process.env, { HOSTNAME: '127.0.0.1', PORT: '0', SITE_URL: 'https://preview.example.test', SITE_INDEXING_ENABLED: 'false', PUBLIC_CONTENT_CACHE: 'disabled', PREVIEW_ACCESS_CONFIG: configPath, PREVIEW_DATA_DATE: '2026-10-30' });
let server, handled = 0, appClosed = false, poolsClosed = false;
mock.module('node:http', { namedExports: { createServer: (...args) => (server = realCreateServer(...args)) } });
mock.module('next', { defaultExport: () => ({ prepare: async () => {}, getRequestHandler: () => async (_request, response) => { handled++; response.end('fixture'); }, getUpgradeHandler: () => () => {}, close: async () => { appClosed = true; } }) });
mock.module('../../scripts/self-hosted/context.cjs', { defaultExport: { configureSelfHostedEnvironment: () => 'self-hosted-public', closeSelfHostedPools: async () => { poolsClosed = true; return 0; } } });
mock.module('../../scripts/self-hosted/reader.ts', { namedExports: { verifySelfHostedReaders: async () => {} } });
mock.module('../../scripts/self-hosted/warm-home.mjs', { namedExports: { warmSelfHostedHome: async () => ({ skipped: true }) } });
mock.module('../../src/server/self-hosted-media/runtime.ts', { namedExports: { selfHostedDisplayStore: () => undefined } });
try {
  await import('../../scripts/self-hosted/server.mjs');
  assert.ok(server?.listening, 'real HTTP server must start');
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const get = headers => new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }); request.on('error', reject); request.end();
  });
  const denied = await get({ Host: config.previewHost });
  assert.equal(denied.status, 403); assert.equal(handled, 0);
  const body = [{ alg: 'RS256', kid: 'fixture' }, { iss: config.issuer, aud: [config.audience], type: 'app', iat: now - 1, exp: now + 300 }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const token = body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
  const allowed = await get({ Host: config.previewHost, 'Cf-Access-Jwt-Assertion': token });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers['x-robots-tag'], 'noindex, nofollow'); assert.equal(allowed.body, 'fixture');
  process.emit('SIGTERM');
  for (let i = 0; i < 100 && !poolsClosed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(server.listening, false); assert.equal(appClosed, true); assert.equal(poolsClosed, true); assert.equal(handled, 1);
  console.log('preview_fixture_pass');
} finally {
  server?.closeAllConnections(); server?.close(); rmSync(directory, { recursive: true, force: true });
}
