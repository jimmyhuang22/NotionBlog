import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import files from '../scripts/self-hosted/profile.cjs';

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
