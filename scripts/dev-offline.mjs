import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureDevelopmentEnvironment } from './development/environment.ts';
import { cleanEnvironment } from './development/clean-environment.mjs';
const args = process.argv.slice(2), nextArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--webpack') nextArgs.push(args[i]);
  else if (['--port', '-p'].includes(args[i]) && /^\d{4,5}$/.test(args[i+1] ?? '') && Number(args[i+1]) >= 1024 && Number(args[i+1]) <= 65535) nextArgs.push('--port', args[++i]);
  else { console.error('Offline development accepts only --port and --webpack.'); process.exit(1); }
}
const env = cleanEnvironment();
env.NOTIONBLOG_DEVELOPMENT_MODE = 'offline';
// Next's worker processes inherit NODE_OPTIONS; loopback HTTP and local SQL remain available.
const preload = fileURLToPath(new URL('./development/offline-network.cjs', import.meta.url));
env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
const at = nextArgs.indexOf('--port'); if (at >= 0) env.PORT = nextArgs[at+1];
configureDevelopmentEnvironment(env);
console.log('Offline demo development: cloud readers and server-side external connections are disabled.');
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', ...nextArgs], { stdio: 'inherit', env });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Offline development could not start.'); process.exitCode=1; });
child.on('exit', code => { process.exitCode=code ?? 1; });
