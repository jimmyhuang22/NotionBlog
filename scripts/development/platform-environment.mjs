// Preserve framework routing metadata, never platform tokens or bypass secrets.
export function preservePlatformMetadata(source, target) {
  if (source.VERCEL !== '1' || source.GITHUB_ACTIONS === 'true') return;
  for (const key of ['VERCEL','VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_URL','VERCEL_BRANCH_URL',
    'VERCEL_PROJECT_PRODUCTION_URL','VERCEL_REGION','VERCEL_DEPLOYMENT_ID','VERCEL_PROJECT_ID']) {
    if (source[key]) target[key] = source[key];
  }
}

export function platformProduction(env) {
  return env.NOTIONBLOG_DEVELOPMENT_MODE !== 'offline' && env.VERCEL === '1' && env.VERCEL_ENV === 'production' &&
    (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production') && env.GITHUB_ACTIONS !== 'true';
}
