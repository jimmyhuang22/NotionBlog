import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { GET } from "../src/app/api/health/content/route.ts";
import { checkWebsiteCapabilities } from "../scripts/check-website-capabilities.ts";
import { verifyRetentionHealth } from "../scripts/database-retention/health.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const legacy = () => json({ data: { provider: "database", databaseVersion: "2" } });

test("public liveness is empty, uncacheable and independent of invalid provider configuration", async () => {
  const code = `
    process.env.CONTENT_PROVIDER='invalid'; process.env.DATABASE_CONTENT_VERSION='private-version';
    process.env.DATABASE_READER_URL='invalid'; process.env.NOTION_TOKEN='synthetic';
    globalThis.fetch=()=>{throw Error('unexpected network');};
    const {registerHooks}=await import('node:module');
    registerHooks({resolve(s,c,next){if(s.includes('/lib/content/')||s==='pg'||s==='@notionhq/client')throw Error('content import forbidden');return next(s,c);}});
    const {GET}=await import('./src/app/api/health/content/route.ts');
    const r=GET(); console.log(JSON.stringify({status:r.status,body:await r.text(),headers:Object.fromEntries(r.headers)}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 204); assert.equal(result.body, "");
  for (const key of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) assert.match(result.headers[key], /no-store/);
  assert.equal(result.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(result.headers["content-type"], undefined);
});

function capabilitiesTransport(failTimeline = false): { fetcher: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  return { paths, fetcher: async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(url.pathname + url.search);
    if (url.pathname === "/api/health/content") return GET();
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
    if (url.searchParams.get("limit") === "0" || url.searchParams.getAll("q").length > 1) return json({ error: {} }, 400);
    if (url.pathname === "/api/pages/unknown") return json({ error: {} }, 404);
    if (failTimeline && url.pathname === "/api/timeline") return json({ error: {} }, 503);
    return json({ data: { items: [], total: 0, hasMore: false, nextCursor: null } });
  } };
}
test("capability acceptance still reads content and never claims provider identity from liveness", async () => {
  const pass = capabilitiesTransport();
  const result = await checkWebsiteCapabilities("http://127.0.0.1:3100", pass.fetcher);
  assert.equal(result.capabilitiesVerified, true); assert.equal(result.providerIdentityVerified, false);
  assert.equal(Object.hasOwn(result, "provider"), false);
  assert.ok(pass.paths.includes("/api/timeline?limit=2"));
  const fail = capabilitiesTransport(true);
  await assert.rejects(checkWebsiteCapabilities("http://127.0.0.1:3100", fail.fetcher), /HTTP contract failed/);
  assert.equal(fail.paths.length, 2);
});
test("capability acceptance rejects the old provider argument before requests", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ["scripts/check-website-capabilities.ts", "http://127.0.0.1:3100", "database"]),
    (error: any) => error.code === 1 && /provider identity in the private runtime/.test(error.stderr));
});
test("retention rejects liveness, generic or cached success, malformed and oversized readiness", async () => {
  const url = "https://example.test/api/health/content";
  await verifyRetentionHealth(url, async (_input, init) => { assert.equal(init?.redirect, "error"); assert.ok(init?.signal); return legacy(); });
  await assert.rejects(verifyRetentionHealth(url, async () => GET()), /RETENTION_HEALTH_MIGRATION_REQUIRED/);
  for (const response of [json({ data: { status: "ok" } }), json({ data: { provider: "mock", databaseVersion: "2" } }),
    json({ data: { provider: "database", databaseVersion: "1" } }), json({ data: { provider: "database", databaseVersion: "2", secret: "synthetic" } }),
    Response.json({ data: { provider: "database", databaseVersion: "2" } }), json({}, 503), new Response("bad", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } })]) {
    await assert.rejects(verifyRetentionHealth(url, async () => response), /RETENTION_HEALTH_FAILED/);
  }
  await assert.rejects(verifyRetentionHealth(url, async () => json({ padding: "x".repeat(4096) })), /RETENTION_HEALTH_TOO_LARGE/);
  for (const invalid of ["invalid", "http://example.test/api/health/content", url + "?x=1", url + "#x", "https://user:pass@example.test/api/health/content", "https://example.test/api/timeline"]) {
    await assert.rejects(verifyRetentionHealth(invalid, async () => { throw Error("must not fetch"); }), /RETENTION_HEALTH_URL_INVALID/);
  }
});
test("actual retention CLI stops on public liveness before database setup or archive writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nb-health-"));
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  try {
    const privateFile = async (name: string, body: string) => { const path = join(dir, name); await writeFile(path, body, { mode: 0o600 }); return path; };
    const locks = [];
    for (let i = 0; i < 4; i++) {
      const body = `lock-${i}`, path = await privateFile(`lock-${i}`, body), s = await stat(path);
      locks.push({ path, ino: s.ino, dev: s.dev, sha256: sha(body) });
    }
    const proof = await privateFile("proof", "synthetic-proof"), program = await privateFile("program", "synthetic-program");
    const syncState = await privateFile("state", JSON.stringify({ status: "PASS", runId: "synthetic-run", operation: "synthetic-operation" }));
    const window = await privateFile("window", JSON.stringify({ format: "retention-daily-window-v2", maximumRuns: 1, runId: "synthetic-run",
      operation: "synthetic-operation", deadline: Date.now() + 180000, syncState, locks, absentLocks: [join(dir, "absent")],
      proofs: Array.from({ length: 5 }, () => ({ path: proof, sha256: sha("synthetic-proof") })), archiveDirectory: join(dir, "archive"),
      healthURL: "https://example.test/api/health/content", programFiles: [{ path: program, sha256: sha("synthetic-program") }] }));
    const code = `
      const {GET}=await import('./src/app/api/health/content/route.ts');
      globalThis.fetch=async()=>GET();
      process.env.RETENTION_DATABASE_URL='invalid';
      process.argv=[process.execPath,'scripts/database-retention/cli.ts','--window',${JSON.stringify(window)}];
      await import('./scripts/database-retention/cli.ts');`;
    await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code], { cwd: resolve(".") }),
      (error: any) => error.code === 1 && /RETENTION_HEALTH_MIGRATION_REQUIRED/.test(error.stderr));
    await assert.rejects(stat(join(dir, "archive")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
