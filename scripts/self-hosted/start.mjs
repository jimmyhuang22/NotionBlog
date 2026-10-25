import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment } from '../development/clean-environment.mjs';
import context from './context.cjs';
import files from './profile.cjs';

context.refusePlatform(process.env);
const options = { hostname: '127.0.0.1', port: '3000' };
let localOnly = false;
const seen = new Set();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === '--local-only' && !localOnly) { localOnly = true; continue; }
  if (!['--config', '--hostname', '--port'].includes(name) || seen.has(name) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('SELF_HOSTED_START_ARGUMENTS');
  seen.add(name);
  options[name.slice(2)] = args[++index];
}
if (!options.config || !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(options.hostname) ||
    !/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535 ||
    localOnly && options.hostname === '0.0.0.0') throw Error('SELF_HOSTED_START_ARGUMENTS');
files.verifyBuild(process.cwd());
const filename = resolve(options.config);
files.readProfile(filename, localOnly);
const env = cleanEnvironment();
delete env.NODE_EXTRA_CA_CERTS;
Object.assign(env, { NODE_ENV: 'production', NB_SELF_HOST_PHASE: 'runtime', NB_SELF_HOST_ROOT: process.cwd(),
  NB_SELF_HOST_PROFILE: filename, NB_SELF_HOST_LOCAL_ONLY: localOnly ? '1' : '0',
  PORT: options.port, HOSTNAME: options.hostname,
  NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./bootstrap.cjs', import.meta.url)))}` });
const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
