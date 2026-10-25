import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import files from '../scripts/self-hosted/profile.cjs';

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const bootstrap = fileURLToPath(new URL('../scripts/self-hosted/bootstrap.cjs', import.meta.url));
const config = new URL('../next.config.ts', import.meta.url).href;
const execution = new URL('../scripts/development/execution.ts', import.meta.url).href;
function environment(extra: Record<string, string | undefined> = {}) {
  return { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: tmpdir(), NODE_ENV: 'test' as const, ...extra };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'self-hosted-'));
  await mkdir(join(dir, '.next'));
  await writeFile(join(dir, '.next/BUILD_ID'), 'synthetic-build');
  await writeFile(join(dir, '.next/required-server-files.json'), JSON.stringify({ config: { env: {} } }));
  await writeFile(join(dir, '.next/notionblog-self-hosted.json'), JSON.stringify(files.buildMarker(dir)));
  await writeFile(join(dir, 'reader.json'), JSON.stringify({ version: 1, environment: {
    DATABASE_READER_URL: 'postgresql://nb_website_reader:fixture@localhost/example',
    DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
    SITE_URL: 'http://localhost:3100',
  } }), { mode: 0o600 });
  return realpath(dir);
}
test('only the dedicated preload activates a self-hosted build; ordinary dotenv flags stay offline', async () => {
  const code = `const {default:c}=await import(${JSON.stringify(config)});const result=c('phase-production-build');console.log(JSON.stringify({provider:process.env.CONTENT_PROVIDER,compiled:result.env?.CONTENT_PROVIDER??null,reader:!!process.env.DATABASE_READER_URL}));`;
  const inherited = { NB_SELF_HOST_PHASE: 'build', NB_SELF_HOST_ROOT: root, DATABASE_READER_URL: 'fixture' };
  const ordinary = await execute(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: environment(inherited) });
  assert.deepEqual(JSON.parse(ordinary.stdout), { provider: 'mock', compiled: 'mock', reader: false });
  const explicit = await execute(process.execPath, ['--require', bootstrap, '--input-type=module', '-e', code], { cwd: root, env: environment(inherited) });
  assert.deepEqual(JSON.parse(explicit.stdout), { provider: 'mock', compiled: null, reader: false });
});
test('runtime reasserts the protected profile after dotenv and module copies share explicit pool closure', async () => {
  const dir = await fixture();
  try {
    const poolModule = new URL('../src/server/database/shared-reader-pool.ts', import.meta.url).href;
    const contextModule = new URL('../scripts/self-hosted/context.cjs', import.meta.url).href;
    const code = `process.env.CONTENT_PROVIDER='notion';process.env.NOTION_TOKEN='fixture';process.env.DATABASE_READER_URL='dotenv-private';const {configureExecutionEnvironment:c}=await import(${JSON.stringify(execution)});const mode=c(process.env);const {sharedContentReaderPool:get}=await import(${JSON.stringify(poolModule)});const p=get(process.env.DATABASE_READER_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);const {closeSelfHostedPools:close}=await import(${JSON.stringify(contextModule)});const a=close(),b=close();const count=await a;console.log(JSON.stringify({mode,provider:process.env.CONTENT_PROVIDER,notion:!!process.env.NOTION_TOKEN,reader:process.env.DATABASE_READER_URL.includes('nb_website_reader'),same:a===b,count,ended:p.ended}));`;
    const result = await execute(process.execPath, ['--require', bootstrap, '--input-type=module', '-e', code], { cwd: dir,
      env: environment({ NB_SELF_HOST_ROOT: dir, NB_SELF_HOST_PHASE: 'runtime', NB_SELF_HOST_PROFILE: join(dir, 'reader.json'), NB_SELF_HOST_LOCAL_ONLY: '1' }) });
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'self-hosted', provider: 'database', notion: false, reader: true, same: true, count: 1, ended: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the real self-hosted build launcher excludes inherited/dotenv secrets and guards descendants without loading a reader', async () => {
  const dir = await fixture();
  try {
    await mkdir(join(dir, 'node_modules/next/dist/bin'), { recursive: true });
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts/check-build-privacy.mjs'), '');
    await writeFile(join(dir, '.env.production.local'), 'CONTENT_PROVIDER=database\nDATABASE_READER_URL=fixture\nUNRELATED_SECRET=fixture\n');
    await writeFile(join(dir, 'node_modules/next/dist/bin/next'), `const fs=require('node:fs');for(const[k,v]of Object.entries(require('node:util').parseEnv(fs.readFileSync('.env.production.local','utf8'))))if(!Object.hasOwn(process.env,k))process.env[k]=v;let blocked=false;try{require('node:net').connect(5432,'fixture.invalid')}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}const code="let blocked=false;try{require('node:net').connect(443,'fixture.invalid')}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}console.log(JSON.stringify({blocked}))";const child=require('node:child_process').spawnSync(process.execPath,['-e',code],{encoding:'utf8'});console.log(JSON.stringify({provider:process.env.CONTENT_PROVIDER,secret:!!process.env.UNRELATED_SECRET||!!process.env.DATABASE_READER_URL,blocked,descendant:JSON.parse(child.stdout).blocked}));`);
    const launcher = fileURLToPath(new URL('../scripts/self-hosted/build.mjs', import.meta.url));
    const result = await execute(process.execPath, [launcher], { cwd: dir, env: environment({ CONTENT_PROVIDER: 'database',
      DATABASE_READER_URL: 'fixture', UNRELATED_SECRET: 'fixture', NB_SELF_HOST_PROFILE: 'must-not-open' }) });
    assert.deepEqual(JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{'))!),
      { provider: 'mock', secret: false, blocked: true, descendant: true });
    files.verifyBuild(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Preview and CI reject the self-hosted bootstrap before opening a profile; incompatible artifacts reject startup', async () => {
  for (const platform of [{ VERCEL: '1', VERCEL_ENV: 'preview' }, { GITHUB_ACTIONS: 'true' }, { CI: 'true' }, { CI: '1' }]) {
    await assert.rejects(execute(process.execPath, ['--require', bootstrap, '-e', ''], { cwd: root,
      env: environment({ NB_SELF_HOST_ROOT: root, NB_SELF_HOST_PHASE: 'runtime', NB_SELF_HOST_PROFILE: 'must-not-open', ...platform }) }), /SELF_HOSTED_PLATFORM_CONFLICT/);
  }
  const dir = await fixture();
  try {
    await writeFile(join(dir, '.next/BUILD_ID'), 'different-build');
    assert.throws(() => files.verifyBuild(dir), /SELF_HOSTED_BUILD_MISMATCH/);
    await writeFile(join(dir, '.next/required-server-files.json'), JSON.stringify({ config: { env: { CONTENT_PROVIDER: 'mock' } } }));
    assert.throws(() => files.buildMarker(dir), /SELF_HOSTED_COMPILED_ENV/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
