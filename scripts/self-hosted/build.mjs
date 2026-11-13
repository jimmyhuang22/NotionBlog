import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment } from '../development/clean-environment.mjs';
import context from './context.cjs';
import files from './profile.cjs';
import { preflight } from './preflight.ts';

context.refusePlatform(process.env);
const args = process.argv.slice(2);
const publicWebsite = args.length === 1 && args[0] === '--public-website';
if (args.length && !publicWebsite) throw Error('SELF_HOSTED_BUILD_ARGUMENTS');
console.log('Self-hosted preflight:', JSON.stringify(await preflight({ root: process.cwd(), stage: 'build' })));
const env = cleanEnvironment();
delete env.NODE_EXTRA_CA_CERTS;
Object.assign(env, { NB_SELF_HOST_ROOT: process.cwd(), NB_SELF_HOST_PHASE: 'build',
  NB_SELF_HOST_PUBLIC_BUILD: publicWebsite ? '1' : '0',
  NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./bootstrap.cjs', import.meta.url)))}` });
let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
for (const argv of [['node_modules/next/dist/bin/next', 'build'], ['scripts/check-build-privacy.mjs']]) {
  const code = await new Promise(resolve => {
    child = spawn(process.execPath, argv, { env, stdio: 'inherit' });
    child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
if (!process.exitCode) {
  await writeFile('.next/notionblog-self-hosted.json', JSON.stringify(files.buildMarker(process.cwd(), publicWebsite)) + '\n');
  console.log('Self-hosted build verified; runtime reader configuration was not loaded.');
}
