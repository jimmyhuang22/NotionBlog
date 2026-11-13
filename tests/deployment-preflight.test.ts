import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkDependencies, checkMemory, checkPaths, preflight } from '../scripts/self-hosted/preflight.ts';

const MiB = 1024 * 1024;
const healthy = { total: 8192 * MiB, hostAvailable: 4096 * MiB, constrained: 1280 * MiB, processAvailable: 1200 * MiB, swapFree: 512 * MiB };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deployment-preflight-'));
  for (const base of [root, join(root, 'scripts/game-sync')]) {
    await mkdir(join(base, 'node_modules/psn-api/dist'), { recursive: true });
    const manifest = { dependencies: { 'psn-api': '2.18.1' } };
    await writeFile(join(base, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(base, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': manifest, 'node_modules/psn-api': { version: '2.18.1' },
      'node_modules/optional-foreign-binary': { version: '1.0.0', optional: true, cpu: ['not-this-architecture'] },
    } }));
    await writeFile(join(base, 'node_modules/psn-api/package.json'), JSON.stringify({ version: '2.18.1', main: 'dist/index.cjs', module: 'dist/index.mjs', types: 'dist/index.d.ts' }));
    for (const name of ['index.cjs', 'index.mjs', 'index.d.ts']) await writeFile(join(base, 'node_modules/psn-api/dist', name), 'throw new Error("must never execute private dependency");');
  }
  return root;
}

test('preflight checks both installations without executing private packages or leaving probes', async () => {
  const root = await fixture();
  try {
    const result = await preflight({ root, stage: 'build', memory: healthy, expectedUid: process.getuid?.(), expectedArch: process.arch });
    assert.equal(result.dependencies, 2);
    assert.equal(result.memory?.capacityMiB, 1280);
    assert.equal((await readdir(root)).some(x => x.startsWith('.nb-preflight-')), false);
    await assert.rejects(preflight({ root, stage: 'build', memory: healthy, expectedUid: -1 }), /PREFLIGHT_IDENTITY/);
    await assert.rejects(preflight({ root, stage: 'build', memory: healthy, expectedArch: 'wrong' }), /PREFLIGHT_ARCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing second-lock psn-api cannot be concealed by the root installation', async () => {
  const root = await fixture();
  try {
    await rm(join(root, 'scripts/game-sync/node_modules/psn-api'), { recursive: true });
    await assert.rejects(checkDependencies(root), /PREFLIGHT_DEPENDENCY: scripts\/game-sync\/node_modules\/psn-api/);
    // The real build launcher must fail before starting Next or producing a marker.
    const launcher = new URL('../scripts/self-hosted/build.mjs', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(launcher)], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' },
    }), /PREFLIGHT_DEPENDENCY/);
    assert.equal((await readdir(root)).includes('.next'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('locked version drift, manifest drift and missing type/ESM entries stop preparation', async () => {
  const root = await fixture();
  try {
    const pkg = join(root, 'scripts/game-sync/node_modules/psn-api/package.json');
    await writeFile(pkg, JSON.stringify({ version: '2.18.0' }));
    await assert.rejects(checkDependencies(root), /locked version mismatch/);
    await writeFile(pkg, JSON.stringify({ version: '2.18.1', main: 'dist/index.cjs', types: 'absent.d.ts' }));
    await assert.rejects(checkDependencies(root), /missing entry or types/);
    await writeFile(pkg, JSON.stringify({ version: '2.18.1', main: 'dist/index.cjs', module: 'absent.mjs' }));
    await assert.rejects(checkDependencies(root), /missing entry or types/);
    await writeFile(join(root, 'scripts/game-sync/package.json'), JSON.stringify({ dependencies: { 'psn-api': '2.19.0' } }));
    await assert.rejects(checkDependencies(root), /PREFLIGHT_LOCK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host memory cannot hide a small container limit and swap cannot substitute for RAM', () => {
  assert.equal(checkMemory(healthy).capacityMiB, 1280);
  assert.throws(() => checkMemory({ ...healthy, constrained: 1024 * MiB, swapFree: 16384 * MiB }), /PREFLIGHT_MEMORY/);
  assert.throws(() => checkMemory({ ...healthy, processAvailable: 500 * MiB }), /PREFLIGHT_MEMORY/);
  assert.throws(() => checkMemory({ ...healthy, hostAvailable: 1200 * MiB }), /PREFLIGHT_MEMORY/);
  assert.throws(() => checkMemory({ ...healthy, constrained: NaN }), /invalid memory/);
  assert.equal(checkMemory({ ...healthy, constrained: 0 }).capacityMiB, 8192);
});

test('missing nonoptional transitive dependencies are rejected even when direct packages exist', async () => {
  const root = await fixture();
  try {
    const file = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(file, 'utf8'));
    lock.packages['node_modules/required-transitive'] = { version: '1.0.0' };
    await writeFile(file, JSON.stringify(lock));
    await assert.rejects(checkDependencies(root), /required-transitive/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build permissions reject read-only output, inaccessible ancestors and symlinks to an old release', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, '.next/cache'), { recursive: true });
    await chmod(join(root, '.next/cache'), 0o500);
    await assert.rejects(checkPaths(root, 'build'), /EACCES/);
    await chmod(join(root, '.next/cache'), 0o700);
    await chmod(root, 0o500);
    await assert.rejects(checkPaths(root, 'build'), /EACCES/);
    await chmod(root, 0o600);
    await assert.rejects(checkPaths(root, 'build'), /EACCES/);
    await chmod(root, 0o700);
    await rm(join(root, '.next'), { recursive: true });
    await symlink(tmpdir(), join(root, '.next'));
    await assert.rejects(checkPaths(root, 'build'), /symlink/);
    await rm(join(root, '.next'));
    await symlink(join(root, 'missing'), join(root, '.next'));
    await assert.rejects(checkPaths(root, 'build'), /ENOENT/);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});

test('runtime permissions require readable output under the runtime identity, not build write access', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async () => {
  const root = await fixture();
  try {
    for (const dir of ['.next/server', 'public', 'scripts/self-hosted']) await mkdir(join(root, dir), { recursive: true });
    await symlink('../node_modules', join(root, '.next/node_modules'));
    await chmod(join(root, 'node_modules/psn-api/dist/index.cjs'), 0o400);
    await checkPaths(root, 'build');
    for (const name of ['.next/BUILD_ID', '.next/required-server-files.json', '.next/notionblog-self-hosted.json', '.next/server/page.js', 'scripts/self-hosted/start.mjs']) await writeFile(join(root, name), 'synthetic');
    await chmod(join(root, '.next/server/page.js'), 0o400);
    await checkPaths(root, 'runtime');
    await chmod(join(root, '.next/server/page.js'), 0o000);
    await assert.rejects(checkPaths(root, 'runtime'), /EACCES/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
