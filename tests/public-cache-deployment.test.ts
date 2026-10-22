import test from "node:test";
import assert from "node:assert/strict";
import { cacheRouteCaller, cacheRouteDeployment } from "../src/server/public-cache/deployment.ts";
import { publicCacheEnabled, publicCacheNamespace, publicCacheSecret } from "../src/server/public-cache/policy.ts";
import { fetchCachedRouteVerdict, routeCacheLookupResponse } from "../src/server/public-cache/route-lookup.ts";

const config = { siteKey: "fixture-site", secret: "ab".repeat(32) };
const env = { VERCEL: "1", VERCEL_URL: "fixture-deploy-team.vercel.app", VERCEL_DEPLOYMENT_ID: "dpl_fixture12345678", PUBLIC_CACHE_ORIGIN: "https://old-production.example" };

test("protected route qualification uses its own fixed deployment and invocation token, never the old production alias", async () => {
  let tokenReads = 0, reads = 0;
  const caller = { ...config, ...await cacheRouteCaller(env, async () => { tokenReads++; return "fixture.oidc.token"; }) };
  assert.equal(tokenReads, 1);
  const request: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, "https://fixture-deploy-team.vercel.app");
    assert.equal(new Headers(init?.headers).get("x-vercel-trusted-oidc-idp-token"), "fixture.oidc.token");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    return routeCacheLookupResponse(new Request(url, init), { ...config, ...cacheRouteDeployment(env) }, async () => { reads++; return "found"; });
  };
  assert.equal(await fetchCachedRouteVerdict("/study/fixture?x=1", caller, request), "found");
  assert.equal(reads, 1);
  await assert.rejects(fetchCachedRouteVerdict("/study/fixture", caller, async () => Response.json({ version: 1, verdict: "found" })), /ROUTE_CACHE_DEPLOYMENT/);
  await assert.rejects(fetchCachedRouteVerdict("/study/fixture", caller, async () => Response.json({ version: 1, verdict: "found", deploymentId: "dpl_other12345678" })), /ROUTE_CACHE_DEPLOYMENT/);
});

test("a request signed for another deployment cannot trigger even one qualification read", async () => {
  const caller = { ...config, ...await cacheRouteCaller(env, async () => "fixture-token") };
  let reads = 0;
  const request: typeof fetch = async (url, init) => routeCacheLookupResponse(new Request(url, init),
    { ...config, deploymentId: "dpl_other12345678" }, async () => { reads++; return "found"; });
  await assert.rejects(fetchCachedRouteVerdict("/study/fixture", caller, request), /ROUTE_CACHE_UNAVAILABLE/);
  assert.equal(reads, 0);
  for (const status of [401, 403, 503]) await assert.rejects(fetchCachedRouteVerdict("/study/fixture", caller, async () => new Response(null, { status })));
});

test("deployment identity and tokens fail closed; fixed local mode never asks for OIDC", async () => {
  const local = await cacheRouteCaller({ PUBLIC_CACHE_ORIGIN: "http://127.0.0.1:3000" }, async () => { throw Error("should not read token"); });
  assert.deepEqual(local, { origin: "http://127.0.0.1:3000" });
  for (const bad of ["evil.example", "fixture.vercel.app/path", "fixture.vercel.app@evil.example", "fixture.vercel.app:443", "https://fixture.vercel.app", "fixture.vercel.app\n"]) {
    assert.throws(() => cacheRouteDeployment({ ...env, VERCEL_URL: bad }));
  }
  assert.throws(() => cacheRouteDeployment({ ...env, VERCEL_DEPLOYMENT_ID: undefined }));
  await assert.rejects(cacheRouteCaller(env, async () => ""));
  await assert.rejects(cacheRouteCaller(env, async () => "token\r\nforged: header"));
  await assert.rejects(cacheRouteCaller(env, async () => { throw Error("SDK missing invocation token"); }));
  await assert.rejects(fetchCachedRouteVerdict("/study/fixture", { ...config, ...local, oidcToken: "unexpected" }));
});

test("cache activation validates self-routing only when enabled and deployment cache entries do not cross releases", () => {
  const active = { ...env, PUBLIC_CONTENT_CACHE: "tagged-v1", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", PUBLIC_CACHE_SITE_KEY: config.siteKey, PUBLIC_CACHE_PURGE_SECRET: config.secret };
  assert.equal(publicCacheEnabled(active), true);
  assert.throws(() => publicCacheEnabled({ ...active, VERCEL_URL: undefined }));
  assert.equal(publicCacheEnabled({ VERCEL: "1", PUBLIC_CONTENT_CACHE: "disabled" }), false);
  assert.notEqual(publicCacheNamespace(active, {}, {}), publicCacheNamespace({ ...active, VERCEL_DEPLOYMENT_ID: "dpl_other12345678" }, {}, {}));
});

test("private purge-secret names support hosting and frozen local operators without accepting conflicting identities", () => {
  const active = { ...env, PUBLIC_CONTENT_CACHE: "tagged-v1", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", PUBLIC_CACHE_SITE_KEY: config.siteKey, CACHE_PURGE_SECRET: config.secret };
  assert.equal(publicCacheEnabled(active), true);
  assert.equal(publicCacheSecret(active), config.secret);
  assert.equal(publicCacheSecret({ PUBLIC_CACHE_PURGE_SECRET: config.secret }), config.secret);
  assert.equal(publicCacheEnabled({ ...active, PUBLIC_CACHE_PURGE_SECRET: config.secret }), true);
  for (const invalid of ["", "too-short", "z".repeat(64)]) assert.throws(() => publicCacheEnabled({ ...active, CACHE_PURGE_SECRET: invalid }), { code: "MISCONFIGURED" });
  assert.throws(() => publicCacheEnabled({ ...active, PUBLIC_CACHE_PURGE_SECRET: "cd".repeat(32) }), { code: "MISCONFIGURED" });
  assert.throws(() => publicCacheSecret({ CACHE_PURGE_SECRET: config.secret, PUBLIC_CACHE_PURGE_SECRET: "cd".repeat(32) }), { code: "MISCONFIGURED" });
});
