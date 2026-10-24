import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateContentReadinessResponse } from "../src/server/content-readiness/response.ts";
import { READINESS_FORMAT, READINESS_PATH } from "../src/server/content-readiness/protocol.ts";
import { verifyRetentionReadiness } from "../scripts/database-retention/readiness.ts";
import { budgetedContentSql, withContentReadBudget } from "../src/server/content-read-budget.ts";
import type { ContentRepository } from "../contracts/repository.ts";

const secret = "a".repeat(64), runId = "00000000-0000-0000-0000-000000000001", nonce = "b".repeat(64);
const sample = { id: "synthetic-status", slug: "synthetic-status" }, target = `https://example.test${READINESS_PATH}`;
const env = { CONTENT_READINESS_SECRET: secret, CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "published", DATABASE_TLS: "verify" };
const body = () => ({ format: READINESS_FORMAT, runId, nonce, sample });
const request = (value: unknown = body(), headers = {}, signal?: AbortSignal) => new Request(target, { method: "POST", signal,
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
function repository(change: { version?: string; missing?: boolean; id?: string; incomplete?: boolean; changed?: boolean; fail?: boolean } = {}): ContentRepository {
  let reads = 0;
  return {
    readSnapshot: async () => { reads++; return { version: change.version ?? `${runId}:${change.changed && reads > 1 ? "2" : "1"}`, records: [] }; },
    get: async () => { if (change.fail) throw Error("raw-private-driver-message"); return change.missing ? null : { item: { kind: "status", id: change.id ?? sample.id, slug: sample.slug }, document: { completeness: change.incomplete ? "partial" : "complete", toc: [], blocks: [] } }; },
  } as unknown as ContentRepository;
}
const responseFor = (change = {}, settings = env) => privateContentReadinessResponse(request(), settings, async () => repository(change));
test("missing/invalid dedicated credentials cannot read a body or construct a content repository", async () => {
  let loads = 0, bodyReads = 0;
  for (const [configured, supplied] of [[undefined, `Bearer ${secret}`], ["", `Bearer ${secret}`], ["bad", `Bearer ${secret}`],
    [secret, ""], [secret, `Bearer ${"c".repeat(64)}`], [secret, `Bearer ${"é".repeat(64)}`]]) {
    const req = request({}, { Authorization: supplied ?? "" });
    Object.defineProperty(req, "body", { get() { bodyReads++; throw Error("must not read"); } });
    const response = await privateContentReadinessResponse(req, { ...env, CONTENT_READINESS_SECRET: configured }, async () => { loads++; return repository(); });
    assert.equal(response.status, 404); assert.equal(await response.text(), ""); assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  assert.equal(loads, 0); assert.equal(bodyReads, 0);
});
test("only exact bounded POST challenges reach the content repository", async () => {
  let loads = 0;
  for (const invalid of [{}, { ...body(), extra: 1 }, { ...body(), nonce: "bad" }, { ...body(), runId: "bad" },
    { ...body(), sample: { ...sample, extra: "private" } }, { ...body(), sample: { ...sample, slug: "a/b" } }, { ...body(), sample: { ...sample, slug: "x".repeat(1200) } }]) {
    const response = await privateContentReadinessResponse(request(invalid), env, async () => { loads++; return repository(); });
    assert.ok([400, 503].includes(response.status));
  }
  assert.equal(loads, 0);
  const get = new Request(target, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal((await privateContentReadinessResponse(get, env, async () => { throw Error(); })).status, 405);
});
test("successful proof is uncached and binds the run and nonce without content or provider fields", async () => {
  const response = await responseFor();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { format: READINESS_FORMAT, status: "ready", runId, nonce } });
  for (const header of ["Cache-Control", "CDN-Cache-Control", "Vercel-CDN-Cache-Control"]) assert.match(response.headers.get(header)!, /no-store/);
});
test("wrong publication, withdrawn/wrong/incomplete sample and driver failure all fail closed", async () => {
  for (const change of [{ version: `10000000-0000-0000-0000-000000000001:1` }, { changed: true }, { missing: true }, { id: "wrong" }, { incomplete: true }, { fail: true }]) {
    const response = await responseFor(change); assert.equal(response.status, 503); assert.equal(await response.text(), "");
  }
  let loads = 0;
  for (const setting of [{ CONTENT_PROVIDER: "mock" }, { CONTENT_PROVIDER: "notion" }, { DATABASE_CONTENT_VERSION: "1" }, { DATABASE_PUBLICATION_MODE: "qualified" }, { DATABASE_TLS: "disable" }]) {
    assert.equal((await privateContentReadinessResponse(request(), { ...env, ...setting }, async () => { loads++; return repository(); })).status, 503);
  }
  assert.equal(loads, 0);
});
test("cancelled probes return promptly and retain per-instance admission until existing work drains", async () => {
  const controller = new AbortController(); let release!: (value: ContentRepository) => void, loaded!: () => void;
  const started = new Promise<void>(ok => { loaded = ok; });
  const pending = privateContentReadinessResponse(request(body(), {}, controller.signal), env, () => { loaded(); return new Promise(ok => { release = ok; }); });
  await started; controller.abort(); assert.equal((await pending).status, 503);
  let second = 0;
  assert.equal((await privateContentReadinessResponse(request(), env, async () => { second++; return repository(); })).status, 503);
  assert.equal(second, 0); release(repository()); await new Promise(ok => setImmediate(ok));
  assert.equal((await responseFor()).status, 200);
});
test("SQL count and received row budgets cannot be reset after rejection or escape between requests", async () => {
  let calls = 0;
  const db = budgetedContentSql({ async query<T>() { calls++; return { rows: [{ value: "synthetic" }] as T[] }; } });
  await withContentReadBudget(new AbortController().signal, async () => {
    await db.query("first"); await assert.rejects(db.query("second")); await assert.rejects(db.query("third"));
  }, { maxQueries: 1 }); assert.equal(calls, 1);
  await withContentReadBudget(new AbortController().signal, async () => {
    await assert.rejects(db.query("oversized")); await assert.rejects(db.query("after-oversized"));
  }, { maxResponseBytes: 1 });
  await withContentReadBudget(new AbortController().signal, () => db.query("separate"), { maxQueries: 1 }); assert.equal(calls, 3);
});
test("maintenance client uses distinct uncached POST challenges and rejects stale or extra proof fields", async () => {
  const nonces: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    const req = new Request(input, init), supplied = JSON.parse(String(init?.body)); nonces.push(supplied.nonce);
    return privateContentReadinessResponse(req, env, async () => repository());
  };
  await verifyRetentionReadiness(target, secret, runId, sample, transport);
  await verifyRetentionReadiness(target, secret, runId, sample, transport);
  assert.notEqual(nonces[0], nonces[1]);
  for (const change of [{ nonce: "c".repeat(64) }, { runId: "wrong" }, { extra: "private" }, { status: "ok" }]) {
    await assert.rejects(verifyRetentionReadiness(target, secret, runId, sample, async (_input, init) => {
      const b = JSON.parse(String(init?.body)); return Response.json({ data: { format: READINESS_FORMAT, status: "ready", runId, nonce: b.nonce, ...change } }, { headers: { "Cache-Control": "no-store" } });
    }), /RETENTION_READINESS_FAILED/);
  }
});
test("maintenance has no public/legacy, redirect, cache or oversized-response fallback", async () => {
  for (const invalid of ["invalid", target.replace("https:", "http:"), target + "?x=1", target + "#x", "https://user:pass@example.test" + READINESS_PATH, "https://example.test/api/health/content"]) {
    await assert.rejects(verifyRetentionReadiness(invalid, secret, runId, sample, async () => { throw Error("must not fetch"); }), /RETENTION_READINESS_INPUT_INVALID/);
  }
  for (const value of [undefined, "", "invalid"]) await assert.rejects(verifyRetentionReadiness(target, value, runId, sample, async () => { throw Error("must not fetch"); }), /RETENTION_READINESS_INPUT_INVALID/);
  for (const response of [new Response(null, { status: 204 }), new Response(null, { status: 302 }), Response.json({ data: {} }),
    Response.json({ data: { provider: "database", databaseVersion: "2" } }, { headers: { "Cache-Control": "no-store" } }),
    new Response("invalid", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } })]) {
    await assert.rejects(verifyRetentionReadiness(target, secret, runId, sample, async () => response), /RETENTION_READINESS_FAILED/);
  }
  await assert.rejects(verifyRetentionReadiness(target, secret, runId, sample, async () => Response.json({ padding: "x".repeat(4096) }, { headers: { "Cache-Control": "no-store" } })), /RETENTION_READINESS_TOO_LARGE/);
});
test("actual route uses the restricted published PGlite runtime without Source or storage reads", async () => {
  const result = await promisify(execFile)(process.execPath, ["--conditions=react-server", "tests/helpers/private-content-readiness-route.ts"], { timeout: 30000 });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true); assert.ok(receipt.queries > 0 && receipt.queries <= 16); assert.equal(receipt.probes, 2);
});
test("actual maintenance CLI requires private pre/post proofs and never records success after failed post-check", async () => {
  for (const mode of ["pre-failure", "post-failure", "pass"]) {
    let stdout: string;
    try {
      stdout = (await promisify(execFile)(process.execPath, ["tests/helpers/retention-readiness-cli.ts", mode], { timeout: 30000 })).stdout;
      assert.equal(mode, "pass");
    } catch (error: any) {
      assert.notEqual(mode, "pass"); assert.equal(error.code, 1); assert.match(error.stderr, /RETENTION_READINESS_FAILED/); stdout = error.stdout;
    }
    const receipt = JSON.parse(stdout!.trim().split("\n").at(-1)!);
    if (mode === "pre-failure") { assert.equal(receipt.queries, 0); assert.equal(receipt.archiveFiles, 0); assert.equal(receipt.nonces.length, 1); }
    else { assert.ok(receipt.queries > 0); assert.equal(receipt.closed, true); assert.equal(receipt.nonces.length, 2); assert.notEqual(receipt.nonces[0], receipt.nonces[1]); }
    assert.equal(receipt.completed, mode === "pass"); assert.equal(receipt.stopped, mode === "post-failure");
  }
});
