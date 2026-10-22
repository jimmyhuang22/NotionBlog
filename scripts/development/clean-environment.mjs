import { readFileSync } from 'node:fs';
import { preservePlatformMetadata } from './platform-environment.mjs';
export { platformProduction } from './platform-environment.mjs';

// Do not inherit credentials, NODE_OPTIONS, npm scripts, proxies or cloud CLIs.
export function cleanEnvironment(source = process.env, directory = process.cwd()) {
  const env = { NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PORT']) {
    if (source[key]) env[key] = source[key];
  }
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']) {
    try {
      // Reserve names before Next dotenv runs, without copying any values.
      for (const line of readFileSync(`${directory}/${name}`, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match && !Object.hasOwn(env, match[1])) env[match[1]] = '';
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  preservePlatformMetadata(source, env);
  return env;
}
