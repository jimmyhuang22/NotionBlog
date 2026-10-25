'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const allowed = new Set([
  'DATABASE_READER_URL', 'DATABASE_TLS', 'DATABASE_CA_CERT', 'DATABASE_CONTENT_VERSION',
  'DATABASE_READ_PROJECTION', 'DATABASE_PUBLICATION_MODE', 'DATABASE_SEARCH_PROJECTION',
  'SITE_URL', 'SITE_CONFIG_JSON', 'CONTENT_FEATURES_JSON', 'SOCIAL_PROVIDER',
  'SOCIAL_READER_DATABASE_URL', 'SOCIAL_READER_DATABASE_TLS', 'SOCIAL_READER_DATABASE_CA_CERT',
  'SOCIAL_READER_CONNECTION_MODE', 'SOCIAL_DISPLAY_MODE', 'SOCIAL_COLLECTION_PLAYBACK',
  'SOCIAL_COLLECTION_DAY_ADDITIONS',
  'SELF_HOSTED_MEDIA_MODE', 'SELF_HOSTED_MEDIA_ROOT',
]);
const defaults = Object.freeze({
  CONTENT_PROVIDER: 'database', DATABASE_CONTENT_VERSION: '2', DATABASE_TLS: 'verify',
  DATABASE_READ_PROJECTION: 'legacy', DATABASE_PUBLICATION_MODE: 'qualified',
  SITE_CONFIG_JSON: '{}', CONTENT_FEATURES_JSON: '{}', SITE_INDEXING_ENABLED: 'false',
  SOCIAL_PROVIDER: 'disabled', SOCIAL_MEDIA_ENABLED: 'false', SOCIAL_COLLECTION_PLAYBACK: 'false',
  SOCIAL_COLLECTION_DAY_ADDITIONS: 'false', SOCIAL_READER_CONNECTION_MODE: 'configured',
  MEDIA_PROVIDER: 'storage', MEDIA_THUMBNAILS: 'disabled', STORAGE_PROVIDER: 'supabase',
  THUMBNAIL_STORAGE_PROVIDER: 'supabase', SOCIAL_DISPLAY_MODE: 'trial', PUBLIC_CONTENT_CACHE: 'disabled',
  NEXT_TELEMETRY_DISABLED: '1', NOTIONBLOG_DEVELOPMENT_MODE: 'self-hosted',
  SELF_HOSTED_MEDIA_MODE: 'disabled', DATABASE_READER_ISOLATION: 'enforce',
});
function fail() { throw Error('SELF_HOSTED_PROFILE_INVALID'); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function database(url, tls, ca, username, localOnly) {
  try {
    const value = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(value.protocol) || decodeURIComponent(value.username) !== username ||
        !value.password || !value.hostname || value.search || value.hash || tls !== 'verify' ||
        !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca ?? '') ||
        localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) fail();
  } catch { fail(); }
}
function loadProfile(filename, localOnly) {
  if (!path.isAbsolute(filename)) fail();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o777) !== 0o600 ||
        process.getuid && stat.uid !== process.getuid()) fail();
    raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (!record(raw) || raw.version !== 1 || Object.keys(raw).sort().join(',') !== 'environment,version' || !record(raw.environment)) fail();
  if (Object.entries(raw.environment).some(([key, value]) => !allowed.has(key) || typeof value !== 'string' || value.length > 32768)) fail();
  const env = { ...defaults, ...raw.environment };
  if (env.DATABASE_CONTENT_VERSION !== '2' || env.DATABASE_PUBLICATION_MODE !== 'qualified' ||
      !['legacy', 'scoped'].includes(env.DATABASE_READ_PROJECTION) || !['disabled', 'database'].includes(env.SOCIAL_PROVIDER) ||
      env.SOCIAL_READER_CONNECTION_MODE !== 'configured') fail();
  database(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT, 'nb_website_reader', localOnly);
  if (env.SOCIAL_PROVIDER === 'database') database(env.SOCIAL_READER_DATABASE_URL, env.SOCIAL_READER_DATABASE_TLS,
    env.SOCIAL_READER_DATABASE_CA_CERT, 'nb_social_reader', localOnly);
  else if (Object.keys(raw.environment).some(key => key.startsWith('SOCIAL_READER_DATABASE_'))) fail();
  if (env.SELF_HOSTED_MEDIA_MODE === 'display-only') {
    if (env.SOCIAL_PROVIDER !== 'disabled' || !path.isAbsolute(env.SELF_HOSTED_MEDIA_ROOT ?? '') ||
        path.resolve(env.SELF_HOSTED_MEDIA_ROOT) !== env.SELF_HOSTED_MEDIA_ROOT ||
        env.SELF_HOSTED_MEDIA_ROOT === path.resolve('public') ||
        env.SELF_HOSTED_MEDIA_ROOT.startsWith(path.resolve('public') + path.sep)) fail();
  } else if (env.SELF_HOSTED_MEDIA_MODE !== 'disabled' || raw.environment.SELF_HOSTED_MEDIA_ROOT !== undefined) fail();
  try {
    const site = new URL(env.SITE_URL);
    if (site.username || site.password || site.search || site.hash || site.pathname !== '/' ||
        site.protocol !== 'https:' && !(site.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname))) fail();
    for (const name of ['SITE_CONFIG_JSON', 'CONTENT_FEATURES_JSON']) if (!record(JSON.parse(env[name]))) fail();
  } catch { fail(); }
  return env;
}
function readProfile(filename, localOnly = false) {
  try { return loadProfile(filename, localOnly); }
  catch { return fail(); } // JSON/driver errors must never echo private input.
}
function digest(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function buildMarker(root) {
  const directory = path.join(root, '.next');
  const files = JSON.parse(fs.readFileSync(path.join(directory, 'required-server-files.json'), 'utf8'));
  if (Object.keys(files.config.env ?? {}).length) throw Error('SELF_HOSTED_COMPILED_ENV');
  return { version: 1, buildId: fs.readFileSync(path.join(directory, 'BUILD_ID'), 'utf8').trim(),
    requiredFilesSha256: digest(path.join(directory, 'required-server-files.json')) };
}
function verifyBuild(root) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, '.next/notionblog-self-hosted.json'), 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(buildMarker(root))) throw Error('SELF_HOSTED_BUILD_MISMATCH');
}
module.exports = { readProfile, buildMarker, verifyBuild };
