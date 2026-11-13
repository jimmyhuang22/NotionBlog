import { access, readFile, readdir, lstat, mkdtemp, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const packageRoots = ['', 'scripts/game-sync'];
type Package = { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>; optional?: boolean; os?: string[]; cpu?: string[]; types?: string; typings?: string; module?: string };
export type Memory = { total: number; hostAvailable: number; constrained: number; processAvailable: number; swapFree: number };
type Options = { root: string; stage: 'build' | 'runtime'; expectedUid?: number; expectedArch?: string; memory?: Memory };

function fail(code: string, detail: string): never { throw new Error(`DEPLOY_PREFLIGHT_${code}: ${detail}`); }
async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }
function matches(values: string[] | undefined, value: string) {
  return !values || (!values.includes(`!${value}`) && (!values.some(x => !x.startsWith('!')) || values.includes(value)));
}

/** Metadata and entry resolution only: never import or run private synchronization code. */
export async function checkDependencies(root: string) {
  let checked = 0;
  for (const relative of packageRoots) {
    const base = join(root, relative);
    const manifest: Package = await json(join(base, 'package.json'));
    const lock = await json(join(base, 'package-lock.json'));
    if (lock.lockfileVersion !== 3 || !lock.packages?.['']) fail('LOCK', `${relative || '.'}: missing v3 lock`);
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const sorted = (v: Record<string, string> = {}) => JSON.stringify(Object.entries(v).sort());
      if (sorted(manifest[group]) !== sorted(lock.packages[''][group])) fail('LOCK', `${relative || '.'}: ${group} drift`);
    }
    for (const [name, metadata] of Object.entries(lock.packages) as [string, Package][]) {
      if (!name) continue;
      if (!name.startsWith('node_modules/') || name.split('/').includes('..')) fail('LOCK', 'unsupported package path');
      if (!matches(metadata.os, process.platform) || !matches(metadata.cpu, process.arch)) continue;
      let installed: Package;
      try { installed = await json(join(base, name, 'package.json')); }
      catch (error) {
        if (metadata.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        fail('DEPENDENCY', `${relative || '.'}/${name}: missing or unreadable package metadata`);
      }
      if (!metadata.version || installed.version !== metadata.version) fail('DEPENDENCY', `${relative || '.'}/${name}: locked version mismatch`);
      checked++;
    }
    const require = createRequire(join(base, 'package.json'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      try {
        // Reused root dependencies must not conceal a missing second installation.
        const installed: Package = await json(join(base, 'node_modules', name, 'package.json'));
        // Font/type-only packages need not have a usable Node entry point.
        if (['next', 'typescript', 'sharp', 'psn-api'].includes(name)) await access(require.resolve(name), constants.R_OK);
        if (name === 'psn-api' && installed.module) await access(join(base, 'node_modules', name, installed.module), constants.R_OK);
        const types = installed.types ?? installed.typings;
        if (types) await access(join(base, 'node_modules', name, types), constants.R_OK);
      } catch { fail('DEPENDENCY', `${relative || '.'}/${name}: missing entry or types; prepare both lockfile installations`); }
    }
  }
  return checked;
}

async function treeAccess(path: string, writable: boolean, root: string, seen = new Set<string>()) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const target = await realpath(path);
    if (target !== root && !target.startsWith(root + sep)) fail('PATH', `${path}: symlink outside this release`);
    // Next may link .next/node_modules to this release's own node_modules.
    if (writable && !(path.startsWith(join(root, '.next/node_modules') + sep) || path === join(root, '.next/node_modules'))) {
      fail('PATH', `${path}: writable output must not be a symlink`);
    }
    if (seen.has(target)) return;
    seen.add(target);
    // Generated dependency links are read inputs; a read-only dependency cache is valid.
    return treeAccess(target, false, root, seen);
  }
  await access(path, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0) | (writable ? constants.W_OK : 0));
  if (stat.isDirectory()) for (const name of await readdir(path)) await treeAccess(join(path, name), writable, root, seen);
}

export async function checkPaths(root: string, stage: 'build' | 'runtime') {
  root = await realpath(root);
  for (let path = root; ; path = dirname(path)) {
    await access(path, constants.X_OK);
    if (dirname(path) === path) break;
  }
  if (stage === 'runtime') {
    for (const path of ['.next', 'public', 'scripts/self-hosted']) await treeAccess(join(root, path), false, root);
    for (const path of ['.next/BUILD_ID', '.next/required-server-files.json', '.next/notionblog-self-hosted.json', 'scripts/self-hosted/start.mjs']) {
      await access(join(root, path), constants.R_OK);
    }
    return;
  }
  const directories = [root];
  for (const name of ['.next', 'next-env.d.ts', 'tsconfig.tsbuildinfo']) {
    try { await lstat(join(root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await treeAccess(join(root, name), true, root);
    if (name === '.next') directories.push(join(root, name));
  }
  for (const directory of directories) {
    // Probe actual creation/deletion under the builder UID, including mount/ACL restrictions.
    const probe = await mkdtemp(join(directory, '.nb-preflight-'));
    await rm(probe, { recursive: true });
  }
}

export async function readMemory(): Promise<Memory> {
  let hostAvailable = freemem(), swapFree = 0;
  if (process.platform === 'linux') {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kib = (name: string) => {
      const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
      if (!match) fail('MEMORY', `cannot read ${name}`);
      return Number(match[1]) * 1024;
    };
    hostAvailable = kib('MemAvailable'); swapFree = kib('SwapFree');
  }
  return { total: totalmem(), hostAvailable, swapFree,
    constrained: process.constrainedMemory(), processAvailable: process.availableMemory() };
}

export function checkMemory(memory: Memory) {
  if (Object.values(memory).some(x => !Number.isFinite(x) || x < 0)) fail('MEMORY', 'invalid memory observation');
  const capacity = Math.min(memory.total, memory.constrained || memory.total);
  const available = Math.min(memory.hostAvailable, memory.processAvailable);
  const report = { capacityMiB: Math.floor(capacity / MiB), availableMiB: Math.floor(available / MiB),
    hostAvailableMiB: Math.floor(memory.hostAvailable / MiB), swapFreeMiB: Math.floor(memory.swapFree / MiB) };
  // Operational floor from the dual-site build, not a guarantee of peak usage.
  // Swap is reported but never added to RAM to make a constrained build pass.
  if (capacity < 1280 * MiB || available < 1024 * MiB || memory.hostAvailable < 1280 * MiB) {
    fail('MEMORY', `${JSON.stringify(report)}; require capacity >=1280 MiB, available >=1024 MiB, host available >=1280 MiB (256 MiB reserve)`);
  }
  return report;
}

export async function preflight(options: Options) {
  const root = resolve(options.root);
  const uid = process.getuid?.();
  if (options.expectedUid !== undefined && options.expectedUid !== uid) fail('IDENTITY', 'run under the actual build/runtime UID');
  if (options.expectedArch && options.expectedArch !== process.arch) fail('ARCH', `expected ${options.expectedArch}, observed ${process.arch}`);
  const dependencies = await checkDependencies(root);
  try { await checkPaths(root, options.stage); }
  catch (error) { fail('PERMISSION', `${options.stage}: ${(error as Error).message}`); }
  const memory = options.stage === 'build' && (options.memory || process.platform === 'linux')
    ? checkMemory(options.memory ?? await readMemory()) : null;
  return { stage: options.stage, platform: process.platform, arch: process.arch, uid, dependencies, memory,
    memoryStatus: options.stage === 'runtime' ? 'not-applicable' : memory ? 'passed' : 'unverified-non-linux' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--stage' || !['build', 'runtime'].includes(args[1]) ||
        args[2] !== '--uid' || !/^\d+$/.test(args[3]) || args[4] !== '--arch' || !['arm64', 'x64'].includes(args[5])) {
      fail('ARGUMENTS', 'run in release directory: preflight.ts --stage build|runtime --uid ACTUAL_UID --arch arm64|x64');
    }
    const result = await preflight({ root: process.cwd(), stage: args[1] as Options['stage'], expectedUid: Number(args[3]), expectedArch: args[5] });
    console.log(JSON.stringify(result));
    if (result.memoryStatus === 'unverified-non-linux') {
      console.error('DEPLOY_PREFLIGHT_MEMORY_UNVERIFIED: repeat in the actual Linux build environment; local metadata/permissions checks are not deployment clearance');
      process.exitCode = 1;
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
