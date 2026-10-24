import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createDirectDenyReader } from "../src/server/database/direct-notion-policy.ts";
import { directPageDenied, directPolicyRepository, primeDirectDenials, verifyDirectPolicy, withDirectPolicy } from "../src/server/notion/direct-policy.ts";
import { directPolicyRuntime } from "../src/server/notion/direct-policy-runtime.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import protocol from "../database/notion-direct-deny-protocol.json" with { type: "json" };
const id = (n: number) => n.toString(16).padStart(32, "0");
const code = (expected: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === expected;

test("direct policy batches candidates, deduplicates nested calls, and has no cross-operation positive cache", async () => {
  let denied = false, factories = 0; const batches: string[][] = [];
  const factory = () => { factories++; return async (ids: readonly string[]) => { batches.push([...ids]); return { revision: "1:2", denied: ids.map(() => denied) }; }; };
  const repo = directPolicyRepository({ async inner() { return directPageDenied(id(1)); }, async outer() {
    await primeDirectDenials(Array.from({ length: 600 }, (_, i) => id(i + 1)));
    return this.inner();
  } }, factory);
  assert.equal(await repo.outer(), false); assert.equal(factories, 1);
  assert.deepEqual(batches.map(b => b.length), [0, 256, 256, 88, 0]);
  denied = true; assert.equal(await repo.inner(), true); assert.equal(factories, 2);
  assert.equal(await directPageDenied(id(1)), false); // Independent workers retain their explicit lease policy.
});

test("policy version changes, malformed results, limits and cancellation reject the entire operation", async () => {
  let rev = "1:2", calls = 0;
  const factory = () => async (ids: readonly string[]) => { calls++; return { revision: rev, denied: ids.map(() => false) }; };
  await assert.rejects(withDirectPolicy(factory, async () => { await directPageDenied(id(1)); rev = "1:3"; return "partial"; }), code("CONTENT_UNAVAILABLE"));
  for (const bad of [{ revision: "bad", denied: [] }, { revision: "1:2", denied: [], ids: [] }, { revision: "1:2", denied: [false] }]) {
    await assert.rejects(withDirectPolicy(() => async () => bad, async () => "partial"), code("CONTENT_UNAVAILABLE"));
  }
  calls = 0;
  await assert.rejects(withDirectPolicy(factory, async () => { for (let i = 0; i < 65; i++) await verifyDirectPolicy(); }), code("CONTENT_UNAVAILABLE"));
  assert.equal(calls, 64);
  await assert.rejects(withDirectPolicy(() => async () => ({ revision: "1:" + "1".repeat(262144), denied: [] }), async () => null), code("CONTENT_UNAVAILABLE"));
  const abort = new AbortController(); calls = 0;
  await assert.rejects(withContentReadBudget(abort.signal, () => withDirectPolicy(factory, async () => { abort.abort(); await directPageDenied(id(1)); })), code("CONTENT_UNAVAILABLE"));
  assert.equal(calls, 1);
});

test("direct runtime requires a verified database binding before it can create a policy reader", () => {
  for (const env of [{}, { DATABASE_READER_URL: "postgres://user:pass@example.test/db", DATABASE_TLS: "disable" }]) {
    assert.throws(() => directPolicyRuntime(2, { NODE_ENV: "test", ...env }), code("MISCONFIGURED"));
  }
});

test("isolated SQL returns only bounded same-order deny flags, with exact owner, body and reader privileges", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.exec("CREATE ROLE fictional_reader LOGIN; GRANT nb_reader TO fictional_reader; CREATE ROLE fictional_stranger LOGIN; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon;");
    const sql = await readFile(new URL(`../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(sql).digest("hex"), protocol.migration.sha256); await db.exec(sql);
    const asRole = (name: string): SqlExecutor => ({ query: async <T>(sql: string, values?: unknown[]) => {
      try { return await db.transaction(async tx => {
        await tx.exec(`SET LOCAL SESSION AUTHORIZATION ${name}`); return tx.query<T>(sql, values);
      }); } finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
    } });
    const reader = asRole("fictional_reader");
    await db.query("SELECT nb_api.set_denied($1,true)", [id(1)]); await db.query("SELECT nb_v2_api.set_denied($1,true)", [id(2)]);
    for (const v of [1, 2] as const) {
      const flags = await createDirectDenyReader(reader, v)([id(2), id(1), id(2), id(99)]);
      assert.deepEqual(flags.denied, v === 1 ? [false, true, false, false] : [true, false, true, false]);
      assert.deepEqual(Object.keys(flags).sort(), ["denied", "revision"]);
      assert.equal(JSON.stringify(flags).includes(id(1)), false);
      assert.equal((await createDirectDenyReader(reader, v)(Array(256).fill(id(1)))).denied.length, 256);
    }
    for (const [v, ids] of [[0, []], [null, []], [1, null], [1, ["invalid"]], [1, [null]], [1, Array(257).fill(id(1))], [1, [[id(1)]]]]) {
      await assert.rejects(reader.query("SELECT nb_policy_api.check_denied($1,$2)", [v, ids]), /NB_DIRECT_POLICY_INPUT/);
    }
    for (const r of ["anon", "authenticated", "service_role", "nb_writer", "fictional_stranger"]) {
      await assert.rejects(asRole(r).query("SELECT nb_policy_api.check_denied(1,ARRAY[]::text[])"), /permission denied/);
      await assert.rejects(createDirectDenyReader(asRole(r), 2)([]), code("MISCONFIGURED"));
    }
    await assert.rejects(reader.query("SELECT * FROM nb_v2.denied"), /permission denied/);
    await assert.rejects(reader.query("SELECT nb_v2_api.set_denied($1,true)", [id(1)]), /permission denied/);
    const mutations = [
      "GRANT SELECT(id) ON nb_v2.denied TO fictional_reader",
      "GRANT EXECUTE ON FUNCTION nb_v2_api.fail_run(uuid,bigint) TO nb_reader",
      "GRANT nb_writer TO fictional_reader",
      "CREATE ROLE fictional_extra NOLOGIN; GRANT fictional_extra TO fictional_reader",
      "GRANT nb_reader TO fictional_reader WITH ADMIN OPTION",
      "GRANT CREATE ON SCHEMA nb_policy_api TO fictional_reader",
      "GRANT EXECUTE ON FUNCTION nb_policy_api.check_denied(integer,text[]) TO anon",
      "ALTER FUNCTION nb_policy_api.check_denied(integer,text[]) SET search_path=public",
      "ALTER FUNCTION nb_policy_api.check_denied(integer,text[]) SECURITY INVOKER",
      "CREATE FUNCTION nb_policy_api.extra() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE OR REPLACE FUNCTION nb_policy_api.check_denied(p_version integer,p_ids text[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT '{\"revision\":\"1:2\",\"denied\":[]}'::jsonb$$",
    ];
    for (const mutation of mutations) await t.test(mutation.split(" ").slice(0, 5).join(" "), async () => {
      await db.exec("BEGIN");
      try {
        await db.exec(mutation);
        const txRole: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
          await db.exec("SET LOCAL SESSION AUTHORIZATION fictional_reader");
          try { return await db.query<T>(sql, values); } finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
        } };
        await assert.rejects(createDirectDenyReader(txRole, 2)([]), code("MISCONFIGURED"));
      } finally { await db.exec("ROLLBACK"); }
    });
    let count = 0;
    const bounded = createDirectDenyReader({ query: async <T>(s: string, p?: unknown[]) => { count++; return reader.query<T>(s, p); } }, 2);
    for (let i = 0; i < 63; i++) await bounded([]);
    await assert.rejects(bounded([]), code("CONTENT_UNAVAILABLE")); assert.equal(count, 64);
  } finally { await db.close(); }
});
