'use strict';
const { install, refusePlatform } = require('./context.cjs');
const { readProfile, verifyBuild } = require('./profile.cjs');
refusePlatform(process.env);
const root = process.env.NB_SELF_HOST_ROOT;
const phase = process.env.NB_SELF_HOST_PHASE;
if (root !== process.cwd() || !['build', 'runtime'].includes(phase)) throw Error('SELF_HOSTED_CONTEXT_MISMATCH');
if (phase === 'build' || process.env.NB_SELF_HOST_LOCAL_ONLY === '1') require('../development/offline-network.cjs').installOfflineNetworkGuard();
let env;
if (phase === 'runtime') {
  verifyBuild(root);
  env = readProfile(process.env.NB_SELF_HOST_PROFILE, process.env.NB_SELF_HOST_LOCAL_ONLY === '1');
} else {
  env = { CONTENT_PROVIDER: 'mock', SOCIAL_PROVIDER: 'mock', CONTENT_FEATURES_JSON: '{}', SITE_CONFIG_JSON: '{}',
    SITE_URL: 'http://127.0.0.1:3000', SITE_INDEXING_ENABLED: 'false', PUBLIC_CONTENT_CACHE: 'disabled',
    MEDIA_THUMBNAILS: 'disabled', SOCIAL_MEDIA_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1',
    NOTIONBLOG_DEVELOPMENT_MODE: 'offline' };
}
install(phase, root, env);
