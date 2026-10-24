import { getContentProvider } from "../../src/lib/content/provider.ts";
import { configureDevelopmentEnvironment } from './environment.ts';
import { platformProduction, preservePlatformMetadata } from './platform-environment.mjs';

/** Also called by instrumentation in fresh serverless workers, before requests. */
export function configureExecutionEnvironment(env: NodeJS.ProcessEnv, phase = 'runtime'): 'production' | 'offline' | 'cloud' {
  const development = phase === 'phase-development-server' || env.NODE_ENV === 'development';
  if (!development && platformProduction(env)) { getContentProvider(env); return 'production'; }
  const metadata: Record<string,string|undefined> = {};preservePlatformMetadata(env,metadata);
  if (env.VERCEL === '1' || env.GITHUB_ACTIONS === 'true') env.NOTIONBLOG_DEVELOPMENT_MODE = 'offline';
  const mode=configureDevelopmentEnvironment(env);
  Object.assign(env,metadata);
  return mode;
}

export const isolatedBrowserPolicy = "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
