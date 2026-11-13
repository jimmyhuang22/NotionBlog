'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const allowed = new Set([
  'DATABASE_READER_URL', 'DATABASE_TLS', 'DATABASE_CA_CERT', 'DATABASE_CONTENT_VERSION',
  'DATABASE_READ_PROJECTION', 'DATABASE_PUBLICATION_MODE', 'DATABASE_SEARCH_PROJECTION',
  'DATABASE_LIBRARY_PAGE',
  'SITE_URL', 'SITE_CONFIG_JSON', 'CONTENT_FEATURES_JSON', 'SOCIAL_PROVIDER',
  'SOCIAL_READER_DATABASE_URL', 'SOCIAL_READER_DATABASE_TLS', 'SOCIAL_READER_DATABASE_CA_CERT',
  'SOCIAL_READER_CONNECTION_MODE', 'SOCIAL_DISPLAY_MODE', 'SOCIAL_COLLECTION_PLAYBACK',
  'SOCIAL_COLLECTION_DAY_ADDITIONS',
  'SELF_HOSTED_MEDIA_MODE', 'SELF_HOSTED_MEDIA_ROOT',
]);
// An explicit public deployment reuses the website's existing read-only cloud
// integrations. Neither profile accepts a database owner or synchronization login.
const publicAllowed = new Set([...allowed,
  'SITE_ANALYTICS_JSON',
  'PUBLIC_CONTENT_CACHE', 'PUBLIC_CACHE_ORIGIN', 'PUBLIC_CACHE_SITE_KEY', 'CACHE_PURGE_SECRET',
  'SITE_INDEXING_ENABLED', 'SITE_DISCOVERY_KINDS_JSON', 'NOTION_SOURCES_JSON',
  'NOTION_TOKEN', 'NOTION_API_VERSION', 'MEDIA_SIGNING_SECRET',
  'DATABASE_SEARCH_CONTEXT', 'DATABASE_SEARCH_RESULT_BUDGET', 'CONTENT_READ_TIMING',
  'MEDIA_PROVIDER', 'MEDIA_DELIVERY_MODE', 'MEDIA_THUMBNAILS', 'MEDIA_THUMBNAIL_QUALIFICATION',
  'PRIVATE_MEDIA_ROOT', 'SOCIAL_MEDIA_PRIVATE_MEDIA_ROOT', 'PREVIEW_ACCESS_CONFIG', 'PREVIEW_DATA_DATE',
  'STORAGE_PROVIDER', 'THUMBNAIL_STORAGE_PROVIDER', 'STORAGE_URL', 'STORAGE_BUCKET',
  'STORAGE_API_KEY', 'STORAGE_READ_TOKEN', 'STORAGE_READER_EMAIL',
  'STORAGE_READER_PASSWORD', 'STORAGE_READER_USER_ID',
  'COS_BUCKET', 'COS_REGION', 'COS_PREFIX', 'COS_SECRET_ID', 'COS_SECRET_KEY',
  'COS_SECURITY_TOKEN', 'COS_CREDENTIALS_EXPIRES_AT', 'COS_READ_TRANSPORT', 'COS_READ_ENDPOINT',
  'SOCIAL_MEDIA_ENABLED', 'SOCIAL_MEDIA_STORAGE_PROVIDER', 'SOCIAL_MEDIA_STORAGE_URL',
  'SOCIAL_MEDIA_STORAGE_BUCKET', 'SOCIAL_MEDIA_STORAGE_API_KEY', 'SOCIAL_MEDIA_STORAGE_READ_TOKEN',
  'SOCIAL_MEDIA_STORAGE_READER_EMAIL', 'SOCIAL_MEDIA_STORAGE_READER_PASSWORD',
  'SOCIAL_MEDIA_STORAGE_READER_USER_ID', 'SOCIAL_MEDIA_COS_BUCKET', 'SOCIAL_MEDIA_COS_REGION',
  'SOCIAL_MEDIA_COS_PREFIX', 'SOCIAL_MEDIA_COS_SECRET_ID', 'SOCIAL_MEDIA_COS_SECRET_KEY',
  'SOCIAL_MEDIA_COS_SECURITY_TOKEN', 'SOCIAL_MEDIA_COS_CREDENTIALS_EXPIRES_AT',
  'SOCIAL_MEDIA_COS_READ_TRANSPORT', 'SOCIAL_MEDIA_COS_READ_ENDPOINT',
]);
const defaults = Object.freeze({
  CONTENT_PROVIDER: 'database', DATABASE_CONTENT_VERSION: '2', DATABASE_TLS: 'verify',
  DATABASE_READ_PROJECTION: 'legacy', DATABASE_PUBLICATION_MODE: 'qualified',
  DATABASE_LIBRARY_PAGE: 'legacy',
  SITE_CONFIG_JSON: '{}', CONTENT_FEATURES_JSON: '{}', SITE_INDEXING_ENABLED: 'false',
  SOCIAL_PROVIDER: 'disabled', SOCIAL_MEDIA_ENABLED: 'false', SOCIAL_COLLECTION_PLAYBACK: 'false',
  SOCIAL_COLLECTION_DAY_ADDITIONS: 'false', SOCIAL_READER_CONNECTION_MODE: 'configured',
  MEDIA_PROVIDER: 'storage', MEDIA_THUMBNAILS: 'disabled', STORAGE_PROVIDER: 'supabase',
  MEDIA_DELIVERY_MODE: 'legacy',
  THUMBNAIL_STORAGE_PROVIDER: 'supabase', SOCIAL_DISPLAY_MODE: 'trial', PUBLIC_CONTENT_CACHE: 'disabled',
  NEXT_TELEMETRY_DISABLED: '1', NOTIONBLOG_DEVELOPMENT_MODE: 'self-hosted',
  SELF_HOSTED_MEDIA_MODE: 'disabled', DATABASE_READER_ISOLATION: 'enforce',
});
function fail() { throw Error('SELF_HOSTED_PROFILE_INVALID'); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function readerLogin(url, username, publicWebsite = false) {
  const value = new URL(url), login = decodeURIComponent(value.username);
  const parts = login.split('.');
  const base = parts[0];
  const expected = base === username || publicWebsite && username === 'nb_website_reader' && /^nb_website_reader_r\d{8}$/.test(base);
  if (!expected || parts.length > 2 || !publicWebsite && parts.length !== 1) fail();
  if (parts.length === 2 && (!/^[a-z0-9]{20}$/.test(parts[1]) ||
      !/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(value.hostname) || !['5432', '6543'].includes(value.port))) fail();
  return base;
}
function database(url, tls, ca, username, localOnly, publicWebsite) {
  try {
    const value = new URL(url);
    readerLogin(url, username, publicWebsite);
    if (!['postgres:', 'postgresql:'].includes(value.protocol) ||
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
  if (!record(raw) || raw.version !== 1 || !record(raw.environment)) fail();
  const publicWebsite = raw.deployment === 'public-website';
  if (Object.keys(raw).sort().join(',') !== (publicWebsite ? 'deployment,environment,version' : 'environment,version') ||
      publicWebsite && localOnly) fail();
  const keys = publicWebsite ? publicAllowed : allowed;
  if (Object.entries(raw.environment).some(([key, value]) => !keys.has(key) || typeof value !== 'string' || value.length > 32768)) fail();
  const env = { ...defaults, ...(publicWebsite ? {
    SOCIAL_COLLECTION_PLAYBACK: 'disabled', SOCIAL_COLLECTION_DAY_ADDITIONS: 'disabled',
  } : {}), ...raw.environment };
  if (publicWebsite) env.SELF_HOSTED_DEPLOYMENT = 'public-website';
  if (env.SITE_ANALYTICS_JSON) require('../../src/server/analytics/config.ts').parseVisitorAnalyticsConfig(env.SITE_ANALYTICS_JSON);
  if (env.DATABASE_CONTENT_VERSION !== '2' || env.DATABASE_PUBLICATION_MODE !== 'qualified' ||
      !['legacy', 'compact'].includes(env.DATABASE_LIBRARY_PAGE) ||
      env.DATABASE_LIBRARY_PAGE === 'compact' && env.DATABASE_READ_PROJECTION !== 'scoped' ||
      !['legacy', 'scoped'].includes(env.DATABASE_READ_PROJECTION) || !['disabled', 'database'].includes(env.SOCIAL_PROVIDER) ||
      !(publicWebsite ? ['configured', 'transaction'] : ['configured']).includes(env.SOCIAL_READER_CONNECTION_MODE)) fail();
  database(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT, 'nb_website_reader', localOnly, publicWebsite);
  if (env.SOCIAL_PROVIDER === 'database') database(env.SOCIAL_READER_DATABASE_URL, env.SOCIAL_READER_DATABASE_TLS,
    env.SOCIAL_READER_DATABASE_CA_CERT, 'nb_social_reader', localOnly, publicWebsite);
  else if (Object.keys(raw.environment).some(key => key.startsWith('SOCIAL_READER_DATABASE_'))) fail();
  if (env.SELF_HOSTED_MEDIA_MODE === 'display-only') {
    if (env.SOCIAL_PROVIDER !== 'disabled' || !path.isAbsolute(env.SELF_HOSTED_MEDIA_ROOT ?? '') ||
        path.resolve(env.SELF_HOSTED_MEDIA_ROOT) !== env.SELF_HOSTED_MEDIA_ROOT ||
        env.SELF_HOSTED_MEDIA_ROOT === path.resolve('public') ||
        env.SELF_HOSTED_MEDIA_ROOT.startsWith(path.resolve('public') + path.sep)) fail();
  } else if (env.SELF_HOSTED_MEDIA_MODE !== 'disabled' || raw.environment.SELF_HOSTED_MEDIA_ROOT !== undefined) fail();
  if (publicWebsite && (env.SELF_HOSTED_MEDIA_MODE !== 'disabled' ||
      !['legacy', 'display-only'].includes(env.MEDIA_DELIVERY_MODE) ||
      !['true', 'false'].includes(env.SITE_INDEXING_ENABLED) ||
      !['storage', 'notion'].includes(env.MEDIA_PROVIDER) ||
      !['enabled', 'disabled'].includes(env.MEDIA_THUMBNAILS) ||
      !['supabase', 'cos', 'private-disk'].includes(env.STORAGE_PROVIDER) ||
      !['supabase', 'cos', 'private-disk'].includes(env.THUMBNAIL_STORAGE_PROVIDER))) fail();
  if (env.MEDIA_DELIVERY_MODE === 'display-only') {
    if (!publicWebsite || env.MEDIA_PROVIDER !== 'storage' || !['supabase', 'private-disk'].includes(env.STORAGE_PROVIDER)) fail();
    if (env.STORAGE_PROVIDER === 'private-disk') {
      const { createPrivateDiskStorage, privateDiskEnabled } = require('../../src/server/database/private-disk-storage.ts');
      if (!privateDiskEnabled(env) || env.THUMBNAIL_STORAGE_PROVIDER !== 'private-disk' ||
          env.SOCIAL_MEDIA_ENABLED === 'true' && env.SOCIAL_MEDIA_STORAGE_PROVIDER !== 'private-disk') fail();
      createPrivateDiskStorage(env.PRIVATE_MEDIA_ROOT, 'reader');
      if (env.SOCIAL_MEDIA_ENABLED === 'true') createPrivateDiskStorage(env.SOCIAL_MEDIA_PRIVATE_MEDIA_ROOT, 'reader');
    } else {
    // Reuse the reader's local configuration validation. These factories make no requests.
    const { createStorageReaderToken } = require('../../src/server/database/reader-auth.ts');
    const { createSupabaseStorage } = require('../../src/server/database/storage.ts');
    const token = createStorageReaderToken({
      storageUrl: env.STORAGE_URL, apiKey: env.STORAGE_API_KEY, staticToken: env.STORAGE_READ_TOKEN,
      email: env.STORAGE_READER_EMAIL, password: env.STORAGE_READER_PASSWORD, userId: env.STORAGE_READER_USER_ID,
    });
    createSupabaseStorage({ url: env.STORAGE_URL, bucket: env.STORAGE_BUCKET, apiKey: env.STORAGE_API_KEY,
      token, role: 'reader' });
    }
  }
  if (env.STORAGE_PROVIDER === 'private-disk' && env.MEDIA_DELIVERY_MODE !== 'display-only') fail();
  require('./access-jwt.ts').loadAccessConfig(env);
  if (publicWebsite && env.PUBLIC_CONTENT_CACHE !== 'disabled') {
    if (env.PUBLIC_CONTENT_CACHE !== 'tagged-v1' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.PUBLIC_CACHE_SITE_KEY ?? '') ||
        !/^[a-f0-9]{64}$/.test(env.CACHE_PURGE_SECRET ?? '')) fail();
    try {
      const origin = new URL(env.PUBLIC_CACHE_ORIGIN);
      if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
          origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) fail();
    } catch { fail(); }
  }
  try {
    const site = new URL(env.SITE_URL);
    if (site.username || site.password || site.search || site.hash || site.pathname !== '/' ||
        publicWebsite && site.protocol !== 'https:' ||
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
function buildMarker(root, publicWebsite = false) {
  const directory = path.join(root, '.next');
  const files = JSON.parse(fs.readFileSync(path.join(directory, 'required-server-files.json'), 'utf8'));
  if (Object.keys(files.config.env ?? {}).length) throw Error('SELF_HOSTED_COMPILED_ENV');
  return { version: 1, buildId: fs.readFileSync(path.join(directory, 'BUILD_ID'), 'utf8').trim(),
    requiredFilesSha256: digest(path.join(directory, 'required-server-files.json')),
    ...(publicWebsite ? { deployment: 'public-website' } : {}) };
}
function verifyBuild(root, publicWebsite) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, '.next/notionblog-self-hosted.json'), 'utf8'));
  const builtPublic = expected.deployment === 'public-website';
  if (publicWebsite !== undefined && publicWebsite !== builtPublic ||
      JSON.stringify(expected) !== JSON.stringify(buildMarker(root, builtPublic))) throw Error('SELF_HOSTED_BUILD_MISMATCH');
}
module.exports = { readProfile, readerLogin, buildMarker, verifyBuild };
