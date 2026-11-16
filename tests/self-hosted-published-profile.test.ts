import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, link, unlink, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import files from '../scripts/self-hosted/profile.cjs';

const execute = promisify(execFile);
const invalid = { message: 'SELF_HOSTED_PROFILE_INVALID' };
const analytics = JSON.stringify({ websiteId: '11111111-1111-4111-8111-111111111111', hostname: 'site.example.invalid',
  origins: ['https://site.example.invalid'], node: 'region-a', endpoint: 'http://127.0.0.1:3106/collect',
  secret: 'a'.repeat(64), clientIpHeader: 'x-real-ip' });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'published-profile-')));
  const filename = join(root, 'website.json');
  const environment: Record<string, string> = {
    DATABASE_READER_URL: 'postgresql://nb_website_reader:fixture@database.example.invalid:5432/example',
    DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nsynthetic-not-a-live-ca\n-----END CERTIFICATE-----',
    SITE_URL: 'https://site.example.invalid', DATABASE_PUBLICATION_MODE: 'published',
    DATABASE_READ_PROJECTION: 'scoped', DATABASE_LIBRARY_PAGE: 'legacy',
    MEDIA_DELIVERY_MODE: 'display-only', STORAGE_PROVIDER: 'private-disk', THUMBNAIL_STORAGE_PROVIDER: 'private-disk',
    PRIVATE_MEDIA_ROOT: join(root, 'media'),
  };
  await mkdir(environment.PRIVATE_MEDIA_ROOT, { mode: 0o700 });
  const write = async (extra: Record<string, string | undefined> = {}, publicWebsite = true) => {
    await writeFile(filename, JSON.stringify({ version: 1, ...(publicWebsite ? { deployment: 'public-website' } : {}),
      environment: { ...environment, ...extra } }), { mode: 0o600 });
  };
  await write();
  return { root, filename, environment, write };
}

test('published scoped private-disk profiles preserve reader defaults, optional social/analytics and qualified behavior', async () => {
  const f = await fixture();
  try {
    const env = files.readProfile(f.filename);
    assert.equal(env.DATABASE_PUBLICATION_MODE, 'published');
    assert.equal(env.DATABASE_READ_PROJECTION, 'scoped');
    assert.equal(env.DATABASE_LIBRARY_PAGE, 'legacy');
    assert.equal(env.MEDIA_DELIVERY_MODE, 'display-only');
    assert.equal(env.PUBLIC_CONTENT_CACHE, 'disabled');
    assert.equal(env.SELF_HOSTED_MEDIA_MODE, 'disabled');
    assert.equal(env.DATABASE_READER_ISOLATION, 'enforce');
    assert.equal(env.DATABASE_TLS, 'verify');
    assert.equal(env.CONTENT_PROVIDER, 'database');
    assert.equal(env.SOCIAL_PROVIDER, 'disabled');
    assert.equal(env.SITE_INDEXING_ENABLED, 'false');
    await f.write({ SOCIAL_PROVIDER: 'database', SOCIAL_READER_CONNECTION_MODE: 'transaction',
      SOCIAL_READER_DATABASE_URL: 'postgresql://nb_social_reader:fixture@database.example.invalid:5432/example',
      SOCIAL_READER_DATABASE_TLS: 'verify', SOCIAL_READER_DATABASE_CA_CERT: f.environment.DATABASE_CA_CERT,
      SOCIAL_MEDIA_ENABLED: 'true', SOCIAL_MEDIA_STORAGE_PROVIDER: 'private-disk',
      SOCIAL_MEDIA_PRIVATE_MEDIA_ROOT: f.environment.PRIVATE_MEDIA_ROOT, SITE_ANALYTICS_JSON: analytics });
    const social = files.readProfile(f.filename);
    assert.equal(social.SOCIAL_READER_CONNECTION_MODE, 'transaction');
    assert.equal(social.SOCIAL_MEDIA_ENABLED, 'true');
    assert.equal(social.SITE_ANALYTICS_JSON, analytics);
    // The exception must not narrow the existing qualified branch.
    for (const page of ['legacy', 'compact']) {
      await f.write({ DATABASE_PUBLICATION_MODE: 'qualified', DATABASE_LIBRARY_PAGE: page });
      assert.equal(files.readProfile(f.filename).DATABASE_LIBRARY_PAGE, page);
    }
    assert.deepEqual(await readdir(f.environment.PRIVATE_MEDIA_ROOT), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('published profiles reject every unsupported combination and still apply downstream guards', async t => {
  const f = await fixture();
  const cases: Record<string, Record<string, string | undefined>> = {
    'v1 content': { DATABASE_CONTENT_VERSION: '1' },
    'unknown publication': { DATABASE_PUBLICATION_MODE: 'unknown' },
    'legacy projection': { DATABASE_READ_PROJECTION: 'legacy' },
    'missing scoped projection': { DATABASE_READ_PROJECTION: undefined },
    'compact pages': { DATABASE_LIBRARY_PAGE: 'compact' },
    'Notion media': { MEDIA_PROVIDER: 'notion' },
    'legacy media': { MEDIA_DELIVERY_MODE: 'legacy' },
    'cloud originals': { STORAGE_PROVIDER: 'supabase' },
    'cloud thumbnails': { THUMBNAIL_STORAGE_PROVIDER: 'supabase' },
    'COS originals': { STORAGE_PROVIDER: 'cos' },
    'local display endpoint': { SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: f.environment.PRIVATE_MEDIA_ROOT },
    'shared cache with complete settings': { PUBLIC_CONTENT_CACHE: 'tagged-v1', PUBLIC_CACHE_SITE_KEY: 'fixture-site',
      CACHE_PURGE_SECRET: 'a'.repeat(64), PUBLIC_CACHE_ORIGIN: 'https://site.example.invalid' },
    'writer login': { DATABASE_READER_URL: 'postgresql://postgres:fixture@database.example.invalid/example' },
    'TLS disabled': { DATABASE_TLS: 'disable' },
    'TLS query override': { DATABASE_READER_URL: f.environment.DATABASE_READER_URL + '?sslmode=disable' },
    'missing CA': { DATABASE_CA_CERT: '' },
    'missing private root': { PRIVATE_MEDIA_ROOT: undefined },
    'relative private root': { PRIVATE_MEDIA_ROOT: 'media' },
    'unnormalized private root': { PRIVATE_MEDIA_ROOT: f.environment.PRIVATE_MEDIA_ROOT + '/../media' },
    'public media root': { PRIVATE_MEDIA_ROOT: resolve('public', 'media') },
    'cloud social media': { SOCIAL_MEDIA_ENABLED: 'true', SOCIAL_MEDIA_STORAGE_PROVIDER: 'supabase' },
    'missing social media root': { SOCIAL_MEDIA_ENABLED: 'true', SOCIAL_MEDIA_STORAGE_PROVIDER: 'private-disk' },
    'social credentials while disabled': { SOCIAL_READER_DATABASE_URL: f.environment.DATABASE_READER_URL },
    'social writer': { SOCIAL_PROVIDER: 'database', SOCIAL_READER_DATABASE_URL: 'postgresql://postgres:fixture@database.example.invalid/example',
      SOCIAL_READER_DATABASE_TLS: 'verify', SOCIAL_READER_DATABASE_CA_CERT: f.environment.DATABASE_CA_CERT },
    'malformed analytics': { SITE_ANALYTICS_JSON: '{private-invalid-input' },
    'malformed access control': { PREVIEW_ACCESS_CONFIG: '{private-invalid-input' },
    'insecure site': { SITE_URL: 'http://localhost:3100' },
    'writer key': { DATABASE_MIGRATION_URL: 'private-invalid-input' },
    'disabled isolation': { DATABASE_READER_ISOLATION: 'off' },
    'unknown field': { UNRECOGNIZED_PROFILE_FIELD: 'private-invalid-input' },
  };
  try {
    for (const [name, extra] of Object.entries(cases)) await t.test(name, async () => {
      await f.write(extra);
      assert.throws(() => files.readProfile(f.filename), invalid);
    });
    await f.write();
    assert.throws(() => files.readProfile(f.filename, true), invalid);
    await f.write({}, false);
    assert.throws(() => files.readProfile(f.filename), invalid);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('published profiles retain file protections and redact malformed or oversized input', async () => {
  const f = await fixture();
  try {
    await chmod(f.filename, 0o644);
    assert.throws(() => files.readProfile(f.filename), invalid);
    await chmod(f.filename, 0o600);
    const alias = join(f.root, 'alias.json');
    await symlink(f.filename, alias);
    assert.throws(() => files.readProfile(alias), invalid);
    await unlink(alias);
    await link(f.filename, alias);
    assert.throws(() => files.readProfile(f.filename), invalid);
    await unlink(alias);
    for (const body of ['{private-invalid-input', ' '.repeat(65537)]) {
      await writeFile(f.filename, body);
      assert.throws(() => files.readProfile(f.filename), invalid);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('dedicated published runtime needs a public artifact and reasserts its profile without external connections', async () => {
  const f = await fixture();
  const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const bootstrap = modulePath('../scripts/self-hosted/bootstrap.cjs');
  const launcher = modulePath('../scripts/self-hosted/start.mjs');
  const guard = join(f.root, 'offline.cjs');
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: 'test' as const };
  try {
    await mkdir(join(f.root, '.next'));
    await writeFile(join(f.root, '.next/BUILD_ID'), 'synthetic-build');
    await writeFile(join(f.root, '.next/required-server-files.json'), JSON.stringify({ config: { env: {} } }));
    await writeFile(join(f.root, '.next/notionblog-self-hosted.json'), JSON.stringify(files.buildMarker(f.root)));
    // Real start entry must accept the profile, then reject the private artifact before spawning a server.
    await assert.rejects(execute(process.execPath, [launcher, '--config', f.filename], { cwd: f.root, env }), /SELF_HOSTED_BUILD_MISMATCH/);
    await writeFile(join(f.root, '.next/notionblog-self-hosted.json'), JSON.stringify(files.buildMarker(f.root, true)));
    await writeFile(guard, `require(${JSON.stringify(modulePath('../scripts/development/offline-network.cjs'))}).installOfflineNetworkGuard();`);
    const execution = new URL('../scripts/development/execution.ts', import.meta.url).href;
    const code = `process.env.DATABASE_PUBLICATION_MODE='qualified';process.env.DATABASE_READ_PROJECTION='legacy';
      process.env.MEDIA_DELIVERY_MODE='legacy';process.env.DATABASE_MIGRATION_URL='private-invalid-input';
      const {configureExecutionEnvironment:c}=await import(${JSON.stringify(execution)});const mode=c(process.env);
      let blocked=false;try{(await import('node:net')).connect(443,'fixture.invalid')}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}
      console.log(JSON.stringify({mode,publication:process.env.DATABASE_PUBLICATION_MODE,projection:process.env.DATABASE_READ_PROJECTION,
        media:process.env.MEDIA_DELIVERY_MODE,writer:!!process.env.DATABASE_MIGRATION_URL,blocked}));`;
    const result = await execute(process.execPath, ['--require', guard, '--require', bootstrap, '--input-type=module', '-e', code],
      { cwd: f.root, env: { ...env, NB_SELF_HOST_ROOT: f.root, NB_SELF_HOST_PHASE: 'runtime', NB_SELF_HOST_PROFILE: f.filename } });
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'self-hosted-public', publication: 'published', projection: 'scoped',
      media: 'display-only', writer: false, blocked: true });
    await f.write({ DATABASE_LIBRARY_PAGE: 'compact' });
    await assert.rejects(execute(process.execPath, [launcher, '--config', f.filename], { cwd: f.root, env }), /SELF_HOSTED_PROFILE_INVALID/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
