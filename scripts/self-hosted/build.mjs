import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment } from '../development/clean-environment.mjs';
import context from './context.cjs';
import files from './profile.cjs';

context.refusePlatform(process.env);
if (process.argv.length !== 2) throw Error('SELF_HOSTED_BUILD_ARGUMENTS');
const env = cleanEnvironment();
delete env.NODE_EXTRA_CA_CERTS;
Object.assign(env, { NB_SELF_HOST_ROOT: process.cwd(), NB_SELF_HOST_PHASE: 'build',
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
  await writeFile('.next/notionblog-self-hosted.json', JSON.stringify(files.buildMarker(process.cwd())) + '\n');
  console.log('Self-hosted build verified; runtime reader configuration was not loaded.');
}
