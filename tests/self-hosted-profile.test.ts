import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import files from '../scripts/self-hosted/profile.cjs';
import { socialCollectionPlaybackEnabled } from '../src/server/social/collection-members.ts';
import { collectionDayAdditionsEnabled } from '../src/server/social/collection-day-additions.ts';

const certificate = '-----BEGIN CERTIFICATE-----\nsynthetic-not-a-live-ca\n-----END CERTIFICATE-----\n';
function profile(extra = {}) {
  return { version: 1, environment: { DATABASE_READER_URL: 'postgresql://nb_website_reader:fixture@localhost:5432/example',
    DATABASE_CA_CERT: certificate, SITE_URL: 'http://localhost:3100', ...extra } };
}
test('self-hosted profile accepts only protected reader configuration and fixes indexing/cache/media defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-profile-')), path = join(root, 'reader.json');
  try {
    await writeFile(path, JSON.stringify(profile()), { mode: 0o600 });
    const env = files.readProfile(path, true);
    assert.equal(env.CONTENT_PROVIDER, 'database'); assert.equal(env.DATABASE_TLS, 'verify');
    assert.equal(env.SITE_INDEXING_ENABLED, 'false'); assert.equal(env.PUBLIC_CONTENT_CACHE, 'disabled');
    assert.equal(env.SOCIAL_MEDIA_ENABLED, 'false');
    assert.equal(env.DATABASE_READER_ISOLATION, 'enforce');
    assert.equal(env.DATABASE_LIBRARY_PAGE, 'legacy');
    await writeFile(path, JSON.stringify(profile({ SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: '/run/notionblog-media' })), { mode: 0o600 });
    assert.equal(files.readProfile(path, true).SELF_HOSTED_MEDIA_MODE, 'display-only');
    await chmod(path, 0o644); assert.throws(() => files.readProfile(path), /SELF_HOSTED_PROFILE_INVALID/);
    await chmod(path, 0o600); await symlink(path, join(root, 'alias.json'));
    assert.throws(() => files.readProfile(join(root, 'alias.json')), /SELF_HOSTED_PROFILE_INVALID/);
    await link(path, join(root, 'hard.json')); assert.throws(() => files.readProfile(path), /SELF_HOSTED_PROFILE_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bad identity, TLS overrides, provider/cache/writer credentials and nonloopback local tests fail without private error output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-invalid-')), path = join(root, 'reader.json');
  try {
    for (const extra of [
      { DATABASE_READER_URL: 'postgresql://postgres:fixture@localhost/example' },
      { DATABASE_READER_URL: 'postgresql://nb_website_reader:fixture@localhost/example?sslmode=disable' },
      { DATABASE_READER_URL: 'postgresql://nb_website_reader:fixture@remote.example.invalid/example' },
      { DATABASE_TLS: 'disable' }, { DATABASE_CA_CERT: '' }, { PUBLIC_CONTENT_CACHE: 'tagged-v1' },
      { NOTION_TOKEN: 'fixture' }, { DATABASE_MIGRATION_URL: 'fixture' },
      { SOCIAL_PROVIDER: 'mock' }, { SITE_URL: 'https://user:fixture@example.invalid' },
      { SOCIAL_PROVIDER: 'database', SOCIAL_READER_CONNECTION_MODE: 'transaction' },
      { SELF_HOSTED_MEDIA_MODE: 'display-only' }, { SELF_HOSTED_MEDIA_MODE: 'other' },
      { SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: '/tmp/../escape' },
      { SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: join(process.cwd(), 'public', 'display') },
      { SELF_HOSTED_MEDIA_ROOT: '/run/notionblog-media' }, { DATABASE_READER_ISOLATION: 'off' },
    ]) {
      await writeFile(path, JSON.stringify(profile(extra)), { mode: 0o600 });
      assert.throws(() => files.readProfile(path, true), error => {
        assert.equal((error as Error).message, 'SELF_HOSTED_PROFILE_INVALID'); return true;
      });
    }
    await writeFile(path, '{"fixture":invalid');
    assert.throws(() => files.readProfile(path), error => { assert.equal((error as Error).message, 'SELF_HOSTED_PROFILE_INVALID'); return true; });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public website profile accepts the rotated reader through the Supabase pooler without enabling shared cache or writer access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-host-profile-')), path = join(root, 'reader.json');
  const publicProfile = (extra = {}) => ({ ...profile({
    DATABASE_READER_URL: 'postgresql://nb_website_reader_r20260101.abcdefghijklmnopqrst:example@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
    SITE_URL: 'https://blog.example.invalid', SITE_INDEXING_ENABLED: 'true',
    MEDIA_PROVIDER: 'notion', MEDIA_THUMBNAILS: 'enabled', NOTION_TOKEN: 'fixture',
    ...extra,
  }), deployment: 'public-website' });
  try {
    await writeFile(path, JSON.stringify(publicProfile()), { mode: 0o600 });
    const env = files.readProfile(path);
    assert.equal(env.SELF_HOSTED_DEPLOYMENT, 'public-website');
    assert.equal(env.SITE_INDEXING_ENABLED, 'true'); assert.equal(env.MEDIA_THUMBNAILS, 'enabled');
    assert.equal(env.PUBLIC_CONTENT_CACHE, 'disabled'); assert.equal(env.DATABASE_READER_ISOLATION, 'enforce');
    assert.equal(env.MEDIA_DELIVERY_MODE, 'legacy');
    assert.equal(env.DATABASE_LIBRARY_PAGE, 'legacy');
    assert.equal(socialCollectionPlaybackEnabled(env.SOCIAL_COLLECTION_PLAYBACK), false);
    assert.equal(collectionDayAdditionsEnabled(env.SOCIAL_COLLECTION_DAY_ADDITIONS), false);
    assert.equal(files.readerLogin(env.DATABASE_READER_URL, 'nb_website_reader', true), 'nb_website_reader_r20260101');
    assert.throws(() => files.readProfile(path, true), /SELF_HOSTED_PROFILE_INVALID/);
    await writeFile(path, JSON.stringify(publicProfile({ DATABASE_LIBRARY_PAGE: 'compact', DATABASE_READ_PROJECTION: 'scoped', PUBLIC_CONTENT_CACHE: 'tagged-v1',
      PUBLIC_CACHE_SITE_KEY: 'example-site', CACHE_PURGE_SECRET: 'a'.repeat(64),
      PUBLIC_CACHE_ORIGIN: 'http://127.0.0.1:3100' })), { mode: 0o600 });
    assert.equal(files.readProfile(path).PUBLIC_CONTENT_CACHE, 'tagged-v1');
    assert.equal(files.readProfile(path).DATABASE_LIBRARY_PAGE, 'compact');
    for (const extra of [
      { DATABASE_LIBRARY_PAGE: 'compact' }, { DATABASE_LIBRARY_PAGE: 'unexpected' },
      { DATABASE_READER_URL: 'postgresql://postgres.abcdefghijklmnopqrst:example@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres' },
      { DATABASE_READER_URL: 'postgresql://nb_website_reader_r20260101.abcdefghijklmnopqrst:fixture@other.example.invalid:5432/postgres' },
      { DATABASE_READER_URL: 'postgresql://nb_website_reader_r20260101.abcdefghijklmnopqrst:example@aws-0-ap-northeast-1.pooler.supabase.com:1234/postgres' },
      { DATABASE_TLS: 'disable' }, { DATABASE_MIGRATION_URL: 'fixture' }, { STORAGE_WRITER_PASSWORD: 'fixture' },
      { PUBLIC_CONTENT_CACHE: 'tagged-v1' }, { SITE_URL: 'http://localhost:3100' },
      { SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: '/run/notionblog-media' },
    ]) {
      await writeFile(path, JSON.stringify(publicProfile(extra)), { mode: 0o600 });
      assert.throws(() => files.readProfile(path), /SELF_HOSTED_PROFILE_INVALID/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public display delivery requires a Supabase reader profile and rejects local display storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-display-profile-'));
  const filename = join(root, 'website.json');
  const publishableKey = 'sb_publishable_fixture';
  const readerToken = (role: string) => 'fixture.' + Buffer.from(JSON.stringify({
    role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600, app_metadata: { notionblog_storage_role: role },
  })).toString('base64url') + '.fixture';
  const display = {
    SITE_URL: 'https://blog.example.invalid', MEDIA_DELIVERY_MODE: 'display-only',
    STORAGE_URL: 'https://storage.example.invalid/storage/v1', STORAGE_BUCKET: 'fixture-media',
    STORAGE_API_KEY: publishableKey, STORAGE_READ_TOKEN: readerToken('reader'),
  };
  const write = (extra = {}, publicWebsite = true) => writeFile(filename,
    JSON.stringify({ ...profile({ ...display, ...extra }), ...(publicWebsite ? { deployment: 'public-website' } : {}) }),
    { mode: 0o600 });
  try {
    await write();
    assert.equal(files.readProfile(filename).MEDIA_DELIVERY_MODE, 'display-only');
    await write({ MEDIA_DELIVERY_MODE: 'legacy', STORAGE_PROVIDER: 'cos', MEDIA_PROVIDER: 'notion' });
    assert.equal(files.readProfile(filename).MEDIA_DELIVERY_MODE, 'legacy');
    for (const extra of [
      { MEDIA_DELIVERY_MODE: '' }, { MEDIA_DELIVERY_MODE: 'unexpected' },
      { STORAGE_PROVIDER: 'cos' }, { MEDIA_PROVIDER: 'notion' },
      { SELF_HOSTED_MEDIA_MODE: 'display-only', SELF_HOSTED_MEDIA_ROOT: '/run/notionblog-media' },
      { SELF_HOSTED_MEDIA_ROOT: '/run/notionblog-media' },
      { STORAGE_READ_TOKEN: readerToken('writer') }, { STORAGE_READ_TOKEN: '' },
      { STORAGE_API_KEY: 'placeholder' }, { STORAGE_READER_EMAIL: 'fixture@example.invalid' },
      { STORAGE_URL: 'https://storage.example.invalid/private' },
    ]) {
      await write(extra);
      assert.throws(() => files.readProfile(filename), { message: 'SELF_HOSTED_PROFILE_INVALID' });
    }
    await write({}, false);
    assert.throws(() => files.readProfile(filename), { message: 'SELF_HOSTED_PROFILE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
