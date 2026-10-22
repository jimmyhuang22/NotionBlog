import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScheduledWebsite } from '../scripts/website-sync/scheduled.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'website-scheduled-'))); await chmod(root, 0o700);
  const stateDir = join(root, 'state'); await mkdir(join(stateDir, 'website-v2'), { recursive: true, mode: 0o700 });
  const configFile = join(root, 'runtime.json'); await writeFile(configFile, JSON.stringify({ format: 'website-v2-runtime-1', privateRoot: root, stateDir }), { mode: 0o600 });
  return { root, configFile, state: join(stateDir, 'website-v2') };
}
const verified = { exitCode: 0, published: true, readerVerified: true, runId: 'test-run' };
test('scheduled website publication requires verified readback and notifies only the first completion', async () => {
  const f = await fixture(), notices: string[] = [], calls: unknown[] = [];
  try {
    const ports = { run: async (options: { configFile: string; mode: string }) => { calls.push(options); return verified; }, notify: async (kind: string) => { notices.push(kind); } };
    await runScheduledWebsite(f.configFile, ports); await runScheduledWebsite(f.configFile, ports);
    assert.deepEqual(calls, [{ configFile: f.configFile, mode: 'publish' }, { configFile: f.configFile, mode: 'publish' }]);
    assert.deepEqual(notices, ['completed']);
    assert.equal(JSON.parse(await readFile(join(f.state, 'scheduled-status-private.json'), 'utf8')).status, 'verified');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('an ambiguous earlier promote blocks a new publication without altering its original receipt', async () => {
  const f = await fixture();
  try {
    const previous = JSON.stringify({ mode: 'publish', exitCode: 1, publicationMayHaveCommitted: true, runId: 'uncertain-run' });
    await writeFile(join(f.state, 'latest-run-private.json'), previous, { mode: 0o600 });
    await assert.rejects(runScheduledWebsite(f.configFile, { run: async () => { assert.fail('must not replay'); }, notify: async () => {} }), { code: 'UNCERTAIN_PREVIOUS_PUBLICATION' });
    assert.equal(await readFile(join(f.state, 'latest-run-private.json'), 'utf8'), previous);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('confirmed pre-promote failures allow a fresh cycle and identical failures do not repeat notifications', async () => {
  const f = await fixture(), notices: string[] = []; let calls = 0;
  try {
    await writeFile(join(f.state, 'latest-run-private.json'), JSON.stringify({ mode: 'publish', exitCode: 1, publicationMayHaveCommitted: false }), { mode: 0o600 });
    const ports = { run: async () => { calls++; throw new Error('private upstream details'); }, notify: async (kind: string) => { notices.push(kind); } };
    for (let n = 0; n < 2; n++) await assert.rejects(runScheduledWebsite(f.configFile, ports), { code: 'SYNC_FAILED' });
    assert.equal(calls, 2); assert.deepEqual(notices, ['failed']);
    assert.equal((await readFile(join(f.state, 'scheduled-status-private.json'), 'utf8')).includes('private upstream details'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a worker exit without successful reader verification cannot count as a scheduled success', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runScheduledWebsite(f.configFile, { run: async () => ({ ...verified, readerVerified: false }), notify: async () => {} }), { code: 'SYNC_FAILED' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('scheduled failures retain only allowlisted receipt codes and suppress identical notifications', async () => {
  const f = await fixture(), notices: string[] = [];
  try {
    for (const resultCode of ['IMAGE_UNAVAILABLE', 'IMAGE_UNAVAILABLE', 'RUN_BUDGET_EXCEEDED', 'https://private.example.test/token']) {
      const expected = resultCode.startsWith('https:') ? 'SYNC_FAILED' : resultCode;
      await assert.rejects(runScheduledWebsite(f.configFile, {
        run: async () => ({ exitCode: 1, published: false, readerVerified: false, code: resultCode }),
        notify: async kind => { notices.push(kind); },
      }), { code: expected });
      const text = await readFile(join(f.state, 'scheduled-status-private.json'), 'utf8');
      assert.equal(JSON.parse(text).code, expected);
      assert.equal(text.includes('private.example'), false);
    }
    assert.deepEqual(notices, ['failed', 'failed', 'failed']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
