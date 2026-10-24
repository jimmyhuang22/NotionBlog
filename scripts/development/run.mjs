import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment, platformProduction } from './clean-environment.mjs';
import { configureDevelopmentEnvironment } from './environment.ts';

const [task, ...args] = process.argv.slice(2);
const node = process.execPath;
const script = name => [node, [name]];
const tests = ['test','check'].includes(task) ? readdirSync('tests').filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`) : [];
const typecheck = script('node_modules/typescript/bin/tsc'); typecheck[1].push('--noEmit');
const check = [script('scripts/check-privacy.mjs'), typecheck, script('scripts/check-database-protocol.ts'), script('scripts/check-website-protocol.ts'),
  [node, ['scripts/media-thumbnails/cli.ts', 'verify']], [node, ['--test', '--test-concurrency=2', ...tests]]];
const tasks = {
  test: [[node, ['--test', '--test-concurrency=2', ...args, ...tests]]],
  check,
  build: [[node, ['node_modules/next/dist/bin/next', 'build', ...args]], script('scripts/check-build-privacy.mjs')],
  start: [[node, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', ...args]]],
};
if (!Object.hasOwn(tasks, task) || (task === 'check' && args.length)) throw new Error('Unsupported isolated task.');
const production = ['build', 'start'].includes(task) && platformProduction(process.env);
const env = production ? { ...process.env } : cleanEnvironment();
if (!production) {
  env.NOTIONBLOG_DEVELOPMENT_MODE = 'offline';
  env.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL('./offline-network.cjs', import.meta.url)))}`;
  configureDevelopmentEnvironment(env);
}
console.log(production ? 'Platform production configuration retained.' : 'Isolated task: local fixtures, PGlite and local media; external Node connections blocked.');
let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
for (const [command, argv] of tasks[task]) {
  const code = await new Promise(resolve => {
    child = spawn(command, argv, { env, stdio: 'inherit' });
    child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
