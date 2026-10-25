'use strict';
// A dotenv value cannot create this process-local context. The dedicated Node
// preload installs it before Next and its inherited workers load configuration.
const key = Symbol.for('notionblog.self-hosted.context.v1');
const prefix = /^(DATABASE_|SOCIAL_|NOTION_|STORAGE_|COS_|SYNC_|MEDIA_|SELF_HOSTED_|CONTENT_|SITE_|NEXT_PUBLIC_|VERCEL_|PUBLIC_CACHE_|PUBLIC_CONTENT_CACHE$)/;

function refusePlatform(env) {
  if (env.VERCEL || env.GITHUB_ACTIONS || env.CI) throw Error('SELF_HOSTED_PLATFORM_CONFLICT');
}
function context() {
  const value = globalThis[key];
  if (!value) return undefined;
  if (value.version !== 1 || value.root !== process.cwd()) throw Error('SELF_HOSTED_CONTEXT_MISMATCH');
  refusePlatform(process.env);
  return value;
}
function install(phase, root, environment) {
  refusePlatform(process.env);
  if (globalThis[key] || root !== process.cwd() || !['build', 'runtime'].includes(phase)) throw Error('SELF_HOSTED_CONTEXT_MISMATCH');
  const pools = new Set();
  let closing;
  const values = Object.freeze({ ...environment });
  const value = Object.freeze({
    version: 1, root, phase,
    apply(env) {
      refusePlatform(env);
      for (const name of Object.keys(env)) if (prefix.test(name)) env[name] = '';
      Object.assign(env, values);
    },
    register(pool) {
      if (phase !== 'runtime' || closing) throw Error('SELF_HOSTED_POOL_LIFECYCLE');
      pools.add(pool);
    },
    close() {
      return closing ??= (async () => {
        const results = await Promise.allSettled([...pools].map(pool => pool.end()));
        if (results.some(result => result.status === 'rejected')) throw Error('SELF_HOSTED_POOL_CLOSE');
        return pools.size;
      })();
    },
  });
  Object.defineProperty(globalThis, key, { value });
  value.apply(process.env);
}
function configureSelfHostedEnvironment(env) {
  const value = context();
  if (!value) return undefined;
  value.apply(env);
  return value.phase === 'build' ? 'self-hosted-build' : 'self-hosted';
}
function registerSelfHostedPool(pool) {
  const value = context();
  if (!value) return false;
  value.register(pool);
  return true;
}
function closeSelfHostedPools() {
  const value = context();
  if (!value || value.phase !== 'runtime') throw Error('SELF_HOSTED_CONTEXT_REQUIRED');
  return value.close();
}
function isSelfHostedRuntime() { return context()?.phase === 'runtime'; }
module.exports = { install, refusePlatform, configureSelfHostedEnvironment, registerSelfHostedPool, closeSelfHostedPools, isSelfHostedRuntime };
