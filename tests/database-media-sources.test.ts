import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { SYNC_SCHEMA_DIGEST, type RunLease, type StoredMedia, type SyncRecord, type PublicationPolicy } from "../contracts/sync.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { configDigest, mediaIdentity } from "../src/server/database/validation.ts";
import { createMediaSourceWriter, readMediaSource, MEDIA_SOURCE_CAPABILITY } from "../src/server/database/media-sources.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { MediaSourceBinding, NotionMediaLocator } from "../src/server/media/notion-source.ts";
import manifest from "../database/media-protocol.json" with { type: "json" };
import { READER_PERMISSIONS_SQL } from "../scripts/check-reader.ts";

// Fictional policy, source locators and image bytes only; no cloud requests.
const id = (index: number) => index.toString(16).padStart(32, "0");
const owners = [id(1), id(2), id(3)];
const body = { blocks: [], toc: [], completeness: "complete" as const };
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
const sha = createHash("sha256").update(bytes).digest("hex");
const locators: NotionMediaLocator[] = [{ kind: "cover" }, { kind: "property", name: "Fictional cover / 中文 \"file\"" }, { kind: "block", id: id(20) }];
const sources: PublicationPolicy["sources"] = [
  { key: "statuses", kind: "status", mode: "all", dataSourceId: id(10), databaseParentId: null },
  { key: "courses", kind: "course", mode: "allowlist", dataSourceId: id(11), databaseParentId: null },
  { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: id(12), databaseParentId: owners[1] },
];
const permits: PublicationPolicy["permits"] = [
  { id: owners[1], kind: "course", sourceKey: "courses", courseId: null, parentId: null },
  { id: owners[2], kind: "study-note", sourceKey: "notes", courseId: owners[1], parentId: owners[1] },
];
const digest = configDigest({ sources, permits });
const locatorKey = (locator: NotionMediaLocator) => locator.kind === "cover" ? "cover" : locator.kind === "block" ? `block:${locator.id}` : `property:${locator.name}`;
const media: StoredMedia[] = owners.map((ownerPageId, index) => ({
  assetId: mediaIdentity(ownerPageId, locatorKey(locators[index]), sha), ownerPageId,
  objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png", width: 1, height: 1,
}));
const bindings: MediaSourceBinding[] = media.map((image, index) => ({
  assetId: image.assetId, ownerPageId: image.ownerPageId, sha256: image.sha256, locator: locators[index],
  delivery: index === 1 ? "storage" : "notion", sourceFingerprint: "a".repeat(64),
}));
function records(): SyncRecord[] {
  const base = (index: number, kind: "status" | "course" | "study-note") => ({
    id: owners[index], kind, slug: owners[index], title: "Fictional content", summary: null, tags: [], updatedAt: null,
    href: kind === "status" ? `/status#${owners[index]}` : kind === "course" ? `/study/${owners[index]}` : `/study/${owners[1]}/notes/${owners[index]}`,
    cover: { id: media[index].assetId, src: `/media/${media[index].assetId}`, alt: "Fictional image", width: 1, height: 1 },
  });
  const evidence = (index: number) => ({ sourceKey: sources[index].key, dataSourceId: sources[index].dataSourceId, databaseParentId: sources[index].databaseParentId,
    courseId: index === 2 ? owners[1] : null, parentId: index === 2 ? owners[1] : null, ordinal: index });
  return [
    { detail: { item: { ...base(0, "status"), kind: "status", recordedAt: null, text: [] }, document: body }, evidence: evidence(0) },
    { detail: { item: { ...base(1, "course"), kind: "course", code: "FICTION", semester: null, ratings: { experience: null, usefulness: null, recommendation: null, difficulty: null } }, document: body }, evidence: evidence(1) },
    { detail: { item: { ...base(2, "study-note"), kind: "study-note", courseId: owners[1], parentId: null, noteType: "note", date: null, breadcrumbs: [] }, document: body }, evidence: evidence(2) },
  ];
}
const unavailable = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CONTENT_UNAVAILABLE";

test("media source migration has an independently verified manifest", async () => {
  assert.equal(manifest.capability, "notionblog-media-source-v1");
  for (const migration of manifest.migrations) {
    const sql = await readFile(new URL(`../database/media-migrations/${migration.file}`, import.meta.url));
    assert.equal(createHash("sha256").update(sql).digest("hex"), migration.sha256);
  }
});

test("private image source index follows the existing PostgreSQL publication lifecycle", async t => {
  const db = await PGlite.create();
  try {
    // Reproduce pre-existing broad default grants, including a BYPASSRLS API role.
    await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb.state SET schema_digest=$1", [SYNC_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/media-migrations/001_media_sources.sql", import.meta.url), "utf8"));
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const reader = role("nb_reader"), worker = role("nb_writer");
    const writer = createDatabaseWriter(worker), indexWriter = createMediaSourceWriter(worker);
    const rawStage = (lease: RunLease, value: unknown) => worker.query("SELECT nb_media_api.stage_sources($1,$2,$3::jsonb)", [lease.runId, lease.fence, JSON.stringify(value)]);
    async function reset(freshness = 600) {
      await db.exec("TRUNCATE nb_media.sources,nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones; UPDATE nb.state SET current_run=NULL,lease_run=NULL,lease_until=NULL,revision=0,epoch=0,fence=0;");
      await db.query("SELECT nb_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [digest, freshness, JSON.stringify(sources), JSON.stringify(permits)]);
    }
    async function stage(): Promise<RunLease> {
      const lease = await writer.begin(randomUUID(), digest);
      await writer.stage(lease, records(), media);
      return lease;
    }
    const promote = (lease: RunLease) => writer.promote(lease, { records: 3, media: 3, complete: true });
    async function publish() {
      const lease = await stage(); await indexWriter.stage(lease, bindings); await promote(lease); return lease;
    }

    await t.test("only the dedicated roles receive their narrow RPCs, with no direct tables", async () => {
      await reset(); const lease = await publish();
      for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
        const actor = role(name);
        await assert.rejects(actor.query("SELECT * FROM nb_media.sources"), /permission denied/);
        await assert.rejects(actor.query("SELECT * FROM nb_media.migrations"), /permission denied/);
        await assert.rejects(actor.query("INSERT INTO nb_media.sources VALUES($1,$2,$3::jsonb)", [lease.runId, media[0].assetId, JSON.stringify(bindings[0])]), /permission denied/);
        await assert.rejects(actor.query("CREATE TABLE nb_media.untrusted_table(id integer)"), /permission denied/);
        if (name !== "nb_reader") await assert.rejects(actor.query("SELECT nb_media_api.read_source($1)", [media[0].assetId]), /permission denied/);
        if (name !== "nb_writer") await assert.rejects(actor.query("SELECT nb_media_api.stage_sources($1,$2,'[]')", [lease.runId, lease.fence]), /permission denied/);
      }
      const flags = await db.query<{ relname: string; relrowsecurity: boolean }>("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='nb_media'::regnamespace AND relkind='r'");
      assert.deepEqual(flags.rows.map(row => [row.relname, row.relrowsecurity]).sort(), [["migrations", true], ["sources", true]]);
      const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='nb_media_api'::regnamespace");
      assert.equal(functions.rows.length, 2);
      for (const fn of functions.rows) {
        assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes("search_path=pg_catalog, nb_media, nb, pg_temp"));
      }
      assert.deepEqual((await db.query("SELECT version FROM nb_media.migrations")).rows, [{ version: "001-media-sources" }]);
    });

    await t.test("a staged binding stays private until its whole content generation is published", async () => {
      await reset(); const lease = await stage(); await indexWriter.stage(lease, bindings);
      await assert.rejects(readMediaSource(reader, media[0].assetId), unavailable);
      await promote(lease);
      for (let index = 0; index < bindings.length; index++) {
        assert.deepEqual(await readMediaSource(reader, media[index].assetId), { media: media[index], binding: bindings[index] });
      }
      const envelope = (await reader.query<{ result: { schemaDigest: string; mediaCapability: string } }>("SELECT nb_media_api.read_source($1) AS result", [media[0].assetId])).rows[0].result;
      assert.equal(envelope.schemaDigest, SYNC_SCHEMA_DIGEST); assert.equal(envelope.mediaCapability, MEDIA_SOURCE_CAPABILITY);
      await assert.rejects(indexWriter.stage(lease, bindings), unavailable);
    });

    await t.test("missing and unknown bindings fail closed rather than expose a descriptor", async () => {
      await reset(); const lease = await stage(); await promote(lease);
      assert.equal(await readMediaSource(reader, media[0].assetId), null);
      assert.equal(await readMediaSource(reader, `a1.${"f".repeat(64)}`), null);
      const envelope = (await reader.query<{ result: { media: unknown; binding: unknown } }>("SELECT nb_media_api.read_source($1) AS result", [media[0].assetId])).rows[0].result;
      assert.equal(envelope.media, null); assert.equal(envelope.binding, null);
    });

    await t.test("new runs cannot reuse an old run's binding even when the asset ID is unchanged", async () => {
      await reset(); await publish(); const next = await stage();
      assert.deepEqual(await readMediaSource(reader, media[0].assetId), { media: media[0], binding: bindings[0] });
      await promote(next); assert.equal(await readMediaSource(reader, media[0].assetId), null);
      const third = await stage(); const updated = { ...bindings[0], sourceFingerprint: "b".repeat(64) };
      await indexWriter.stage(third, [updated]); await promote(third);
      assert.deepEqual(await readMediaSource(reader, media[0].assetId), { media: media[0], binding: updated });
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_media.sources")).rows[0].count, 4);
    });

    await t.test("owner and ancestor withdrawal remove previously readable source locations", async () => {
      await reset(); await publish();
      await db.query("SELECT nb_api.set_denied($1,true)", [owners[0]]);
      assert.equal(await readMediaSource(reader, media[0].assetId), null);
      assert.ok(await readMediaSource(reader, media[2].assetId));
      await db.query("SELECT nb_api.set_denied($1,true)", [owners[1]]);
      assert.equal(await readMediaSource(reader, media[1].assetId), null);
      assert.equal(await readMediaSource(reader, media[2].assetId), null);
    });

    await t.test("expired snapshots and a changed policy cannot authorize the old index", async () => {
      await reset(); await publish();
      await db.exec("UPDATE nb.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE status='published'");
      await assert.rejects(readMediaSource(reader, media[0].assetId), unavailable);
      await reset(); await publish();
      await db.query("SELECT nb_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
      await assert.rejects(readMediaSource(reader, media[0].assetId), unavailable);
    });

    await t.test("a valid active lease is required, including its fence and expiry", async () => {
      await reset(); const lease = await stage();
      await assert.rejects(indexWriter.stage({ ...lease, fence: String(BigInt(lease.fence) + 1n) }, bindings), unavailable);
      await assert.rejects(indexWriter.stage({ ...lease, runId: randomUUID() }, bindings), unavailable);
      await db.exec("UPDATE nb.state SET lease_until=clock_timestamp()-interval '1 second'");
      await assert.rejects(indexWriter.stage(lease, bindings), unavailable);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_media.sources")).rows[0].count, 0);
      await reset(); const expired = await stage();
      await db.query("UPDATE nb.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.runId]);
      await assert.rejects(indexWriter.stage(expired, bindings), unavailable);
      await reset(); const changed = await stage();
      await db.query("SELECT nb_api.set_denied($1,true)", [owners[0]]);
      await assert.rejects(indexWriter.stage(changed, bindings), unavailable);
    });

    await t.test("SQL rejects malformed shapes, wrong locators, owners and hashes without partial writes", async () => {
      await reset(); const lease = await stage();
      const malformed = [null, {}, { ...bindings[0], ownerPageId: owners[1] }, { ...bindings[0], sha256: "f".repeat(64) },
        { ...bindings[0], sourceFingerprint: "bad" }, { ...bindings[0], delivery: "external" },
        { ...bindings[0], locator: { kind: "block", id: "bad" } }, { ...bindings[0], locator: { kind: "property", name: "" } },
        { ...bindings[0], locator: { kind: "cover", url: "https://fictional.example.test/private" } },
        { ...bindings[0], locator: locators[2] }, { ...bindings[0], url: "https://fictional.example.test/private" }];
      for (const invalid of malformed) await assert.rejects(rawStage(lease, [bindings[1], invalid]), /NB_MEDIA_SOURCE_(INVALID|OWNER_INVALID)/);
      const missing = { ...bindings[0], sha256: "f".repeat(64), assetId: mediaIdentity(owners[0], "cover", "f".repeat(64)) };
      await assert.rejects(rawStage(lease, [missing]), /NB_MEDIA_SOURCE_OWNER_INVALID/);
      await assert.rejects(rawStage(lease, [bindings[0], bindings[0]]), /NB_MEDIA_SOURCE_BATCH_INVALID/);
      await assert.rejects(rawStage(lease, {}), /NB_MEDIA_SOURCE_BATCH_INVALID/);
      await assert.rejects(rawStage(lease, Array.from({ length: 101 }, () => bindings[0])), /NB_MEDIA_SOURCE_BATCH_INVALID/);
      await assert.rejects(rawStage(lease, [{ ...bindings[0], extra: "x".repeat(262144) }]), /NB_MEDIA_SOURCE_BATCH_INVALID/);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_media.sources")).rows[0].count, 0);
      await indexWriter.stage(lease, bindings); await indexWriter.stage(lease, bindings);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_media.sources")).rows[0].count, 3);
    });

    await t.test("binding reads and writes also check the staged/current core descriptor SHA", async () => {
      await reset(); const lease = await stage(); await indexWriter.stage(lease, bindings);
      await db.query("UPDATE nb.media SET descriptor=jsonb_set(descriptor,'{sha256}',to_jsonb($1::text)) WHERE run_id=$2 AND asset_id=$3", ["f".repeat(64), lease.runId, media[0].assetId]);
      await assert.rejects(rawStage(lease, [bindings[0]]), /NB_MEDIA_SOURCE_OWNER_INVALID/);
      await promote(lease); assert.equal(await readMediaSource(reader, media[0].assetId), null);
    });
  } finally { await db.close(); }
});

test("media source adapter rejects incompatible or malformed envelopes without leaking driver errors", async () => {
  const projection = { schemaDigest: SYNC_SCHEMA_DIGEST, mediaCapability: MEDIA_SOURCE_CAPABILITY, media: media[0], binding: bindings[0] };
  const fake = (result: unknown): SqlExecutor => ({ async query<T>() { return { rows: [{ result }] as T[] }; } });
  for (const invalid of [{ ...projection, schemaDigest: "incorrect" }, { ...projection, mediaCapability: "incorrect" },
    { ...projection, media: null }, { ...projection, binding: null },
    { ...projection, binding: { ...bindings[0], ownerPageId: owners[1] } },
    { ...projection, binding: { ...bindings[0], url: "https://fictional.example.test/private" } },
    { ...projection, binding: { ...bindings[0], locator: { kind: "cover", url: "https://fictional.example.test/private" } } }]) {
    await assert.rejects(readMediaSource(fake(invalid), media[0].assetId), unavailable);
  }
  const failed: SqlExecutor = { async query() { throw new Error("private database source detail"); } };
  await assert.rejects(readMediaSource(failed, media[0].assetId), error => unavailable(error) && !String(error).includes("private database source detail"));
  assert.equal(await readMediaSource(failed, "invalid"), null);
  await assert.rejects(createMediaSourceWriter(failed).stage({} as RunLease, Array.from({ length: 101 }, () => bindings[0])), unavailable);
  await assert.rejects(createMediaSourceWriter(failed).stage({} as RunLease, [{ ...bindings[0], sourceFingerprint: "x".repeat(262144) }]), unavailable);
});

test("reader catalog audit recognizes the image read extension and rejects extra index privileges", async t => {
  const db = await PGlite.create();
  const safe = { safe_login: true, reader_only: true, create_denied: true, private_tables_denied: true, read_allowed: true, write_denied: true };
  try {
    for (const path of ["migrations/001_content.sql", "reader-migrations/001_status.sql", "media-migrations/001_media_sources.sql"]) {
      await db.exec(await readFile(new URL(`../database/${path}`, import.meta.url), "utf8"));
    }
    await db.exec("CREATE ROLE fixture_media_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT; GRANT nb_reader TO fixture_media_reader;");
    async function permissions() {
      await db.exec("SET SESSION AUTHORIZATION fixture_media_reader");
      try { return (await db.query<Record<string, boolean>>(READER_PERMISSIONS_SQL)).rows[0]; }
      finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
    }
    assert.deepEqual(await permissions(), safe);
    const cases = [
      ["GRANT SELECT ON nb_media.sources TO fixture_media_reader", "REVOKE SELECT ON nb_media.sources FROM fixture_media_reader", "private_tables_denied"],
      ["GRANT SELECT(binding) ON nb_media.sources TO fixture_media_reader", "REVOKE SELECT(binding) ON nb_media.sources FROM fixture_media_reader", "private_tables_denied"],
      ["GRANT SELECT ON nb_media.migrations TO fixture_media_reader", "REVOKE SELECT ON nb_media.migrations FROM fixture_media_reader", "private_tables_denied"],
      ["GRANT EXECUTE ON FUNCTION nb_media_api.stage_sources(uuid,bigint,jsonb) TO fixture_media_reader", "REVOKE EXECUTE ON FUNCTION nb_media_api.stage_sources(uuid,bigint,jsonb) FROM fixture_media_reader", "write_denied"],
      ["GRANT nb_writer TO fixture_media_reader", "REVOKE nb_writer FROM fixture_media_reader", "reader_only"],
      ["GRANT CREATE ON SCHEMA nb_media TO fixture_media_reader", "REVOKE CREATE ON SCHEMA nb_media FROM fixture_media_reader", "create_denied"],
      ["GRANT CREATE ON SCHEMA nb_media_api TO fixture_media_reader", "REVOKE CREATE ON SCHEMA nb_media_api FROM fixture_media_reader", "create_denied"],
      ["REVOKE EXECUTE ON FUNCTION nb_media_api.read_source(text) FROM nb_reader", "GRANT EXECUTE ON FUNCTION nb_media_api.read_source(text) TO nb_reader", "read_allowed"],
    ];
    for (const [grant, revoke, key] of cases) await t.test(key, async () => {
      await db.exec(grant);
      try { assert.equal((await permissions())[key], false); }
      finally { await db.exec(revoke); }
    });
    await t.test("missing image RPC schema usage is rejected", async () => {
      await db.exec("REVOKE USAGE ON SCHEMA nb_media_api FROM nb_reader");
      try { await assert.rejects(permissions(), /permission denied/); }
      finally { await db.exec("GRANT USAGE ON SCHEMA nb_media_api TO nb_reader"); }
    });
    assert.deepEqual(await permissions(), safe);
  } finally { await db.close(); }
});
