/** Only server configuration selects the destination; never an incoming Host/header. */
export function cacheRouteDeployment(env: Record<string, string | undefined> = process.env): { origin: string; deploymentId?: string } {
  if (env.VERCEL !== "1") return { origin: env.PUBLIC_CACHE_ORIGIN ?? "" };
  const host = env.VERCEL_URL ?? "", deploymentId = env.VERCEL_DEPLOYMENT_ID ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(host) || !/^dpl_[a-zA-Z0-9]{8,96}$/.test(deploymentId))
    throw Error("ROUTE_CACHE_DEPLOYMENT");
  return { origin: `https://${host}`, deploymentId };
}

export async function cacheRouteCaller(env: Record<string, string | undefined> = process.env,
  token: () => Promise<string> = async () => (await import("@vercel/oidc")).getVercelOidcTokenSync()) {
  const target = cacheRouteDeployment(env);
  if (!target.deploymentId) return target;
  // The synchronous SDK getter uses this invocation's platform token; no CLI refresh or long-lived bypass secret.
  const oidcToken = await token();
  if (!oidcToken || oidcToken.length > 16_384 || /[\r\n\s]/.test(oidcToken)) throw Error("ROUTE_CACHE_IDENTITY");
  return { ...target, oidcToken };
}
