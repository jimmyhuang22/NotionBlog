import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { SYNC_SCHEMA_DIGEST, type RunLease, type StoredMedia, type SyncRecord } from "../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createMediaSourceWriter } from "../src/server/database/media-sources.ts";
import { createWebsiteMediaSourceWriter } from "../src/server/database/website-media-sources.ts";
import { configDigest, mediaIdentity } from "../src/server/database/validation.ts";
import { createThumbnailRegistrar, readThumbnail, THUMBNAIL_CAPABILITY, type ThumbnailRegistration, type ThumbnailWidth } from "../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { locatorIdentity, type MediaSourceBinding, type MediaSourceVersion } from "../src/server/media/notion-source.ts";
import { READER_PERMISSIONS_SQL } from "../scripts/check-reader.ts";

const migration = new URL("../supabase/migrations/20261011123536_media_thumbnails.sql", import.meta.url);
const id = (n: number) => n.toString(16).padStart(32, "0");
const owners = [id(1), id(2), id(3)];
const body = { blocks: [], toc: [], completeness: "complete" as const };
const originalBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
const originalSha = createHash("sha256").update(originalBytes).digest("hex");
const fingerprint = "a".repeat(64);
const sources = [
  { key: "statuses", kind: "status" as const, mode: "all" as const, dataSourceId: id(10), databaseParentId: null },
  { key: "courses", kind: "course" as const, mode: "allowlist" as const, dataSourceId: id(11), databaseParentId: null },
  { key: "notes", kind: "study-note" as const, mode: "allowlist" as const, dataSourceId: id(12), databaseParentId: owners[1] },
];
const permits = [
  { id: owners[1], kind: "course" as const, sourceKey: "courses", courseId: null, parentId: null },
  { id: owners[2], kind: "study-note" as const, sourceKey: "notes", courseId: owners[1], parentId: owners[1] },
];
const digest = configDigest({ sources, permits });
function media(version: MediaSourceVersion): StoredMedia[] {
  return owners.map((ownerPageId, index) => ({
    assetId: mediaIdentity(ownerPageId, locatorIdentity(index === 2 ? { kind: "block", id: id(20) } : { kind: "cover" }, version), originalSha),
    ownerPageId, objectKey: `sha256/${originalSha}`, sha256: originalSha, byteSize: originalBytes.length,
    mime: "image/png", width: 1, height: 1,
  }));
}
function bindings(version: MediaSourceVersion): MediaSourceBinding[] {
  return media(version).map((m, index) => ({ assetId: m.assetId, ownerPageId: m.ownerPageId, sha256: m.sha256,
    locator: index === 2 ? { kind: "block", id: id(20) } : { kind: "cover" }, delivery: "notion", sourceFingerprint: fingerprint }));
}
function records(version: MediaSourceVersion): SyncRecord[] {
  const images = media(version);
  const base = (index: number, kind: "status" | "course" | "study-note") => ({
    id: owners[index], kind, slug: owners[index], title: "Fictional content", summary: null, tags: [], updatedAt: null,
    href: kind === "status" ? `/status#${owners[index]}` : kind === "course" ? `/study/${owners[index]}` : `/study/${owners[1]}/notes/${owners[index]}`,
    cover: { id: images[index].assetId, src: `/media/${version === "v2" ? "v2/" : ""}${images[index].assetId}`, alt: "Fictional image", width: 1, height: 1 },
  });
  const evidence = (index: number) => ({ sourceKey: sources[index].key, dataSourceId: sources[index].dataSourceId,
    databaseParentId: sources[index].databaseParentId, courseId: index === 2 ? owners[1] : null, parentId: index === 2 ? owners[1] : null, ordinal: index });
  return [
    { detail: { item: { ...base(0, "status"), kind: "status", recordedAt: null, text: [] }, document: body }, evidence: evidence(0) },
    { detail: { item: { ...base(1, "course"), kind: "course", code: "FICTION", semester: null, ratings: { experience: null, usefulness: null, recommendation: null, difficulty: null } }, document: body }, evidence: evidence(1) },
    { detail: { item: { ...base(2, "study-note"), kind: "study-note", courseId: owners[1], parentId: null, noteType: "note", date: null, breadcrumbs: [] }, document: body }, evidence: evidence(2) },
  ];
}
// Index tests use fictional output metadata; encoder tests separately verify actual pixels/bytes.
function thumbnail(parent: StoredMedia, widthCap: ThumbnailWidth = 400, outputSha = "b".repeat(64)): StoredMedia {
  return { assetId: mediaIdentity(parent.ownerPageId, `thumbnail:${widthCap}:${parent.assetId}`, outputSha),
    ownerPageId: parent.ownerPageId, objectKey: `sha256/${outputSha}`, sha256: outputSha, byteSize: 100,
    mime: "image/webp", width: 1, height: 1 };
}
const unavailable = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CONTENT_UNAVAILABLE";

async function install(versions: MediaSourceVersion[]) {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
  for (const version of versions) {
    await db.exec(await readFile(new URL(version === "v1" ? "../database/migrations/001_content.sql" : "../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query(`UPDATE ${version === "v1" ? "nb" : "nb_v2"}.state SET schema_digest=$1`, [version === "v1" ? SYNC_SCHEMA_DIGEST : WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL(version === "v1" ? "../database/media-migrations/001_media_sources.sql" : "../database/website-media-migrations/001_website_media_sources.sql", import.meta.url), "utf8"));
  }
  await db.exec(await readFile(migration, "utf8"));
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), worker = role("nb_writer");
  function core(version: MediaSourceVersion) {
    const namespace = version === "v1" ? "nb" : "nb_v2";
    const writer = version === "v1" ? createDatabaseWriter(worker) : createWebsiteWriter(worker);
    const index = version === "v1" ? createMediaSourceWriter(worker) : createWebsiteMediaSourceWriter(worker);
    async function configure() {
      await db.query(`SELECT ${namespace}_api.configure_policy($1,600,$2::jsonb,$3::jsonb)`, [digest,
        JSON.stringify(version === "v1" ? sources : sources.map(source => ({ ...source, pageId: null }))), JSON.stringify(permits)]);
    }
    async function stage(runId = randomUUID(), includeSources = true): Promise<RunLease> {
      const lease = await writer.begin(runId, digest); await writer.stage(lease, records(version), media(version));
      if (includeSources) await index.stage(lease, bindings(version)); return lease;
    }
    const promote = (lease: RunLease) => writer.promote(lease, { records: 3, media: 3, complete: true });
    const publish = async (runId = randomUUID(), includeSources = true) => { const lease = await stage(runId, includeSources); await promote(lease); return lease; };
    return { namespace, configure, stage, promote, publish };
  }
  const registration = (version: MediaSourceVersion, runId: string, index = 0, widthCap: ThumbnailWidth = 400): ThumbnailRegistration => ({
    version, runId, assetId: media(version)[index].assetId, sourceSha256: originalSha, sourceFingerprint: fingerprint, widthCap,
    thumbnail: thumbnail(media(version)[index], widthCap),
  });
  const rawRegister = (input: ThumbnailRegistration) => worker.query("SELECT nb_thumbnail_api.register_media($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [input.version, input.runId, input.assetId, input.sourceSha256, input.sourceFingerprint, input.widthCap, JSON.stringify(input.thumbnail)]);
  return { db, role, reader, worker, core, registration, rawRegister };
}

for (const version of ["v1", "v2"] as const) test(`${version}-only thumbnail registration obeys current content eligibility`, async t => {
  const { db, reader, worker, core, registration, rawRegister } = await install([version]);
  const c = core(version), registrar = createThumbnailRegistrar(worker), images = media(version);
  try {
    await c.configure();
    await t.test("only published eligible sources accept append-only derivatives", async () => {
      const lease = await c.stage(); const input = registration(version, lease.runId);
      await assert.rejects(registrar.register(input), unavailable);
      await assert.rejects(readThumbnail(reader, version, images[0].assetId, 400), unavailable);
      await c.promote(lease);
      assert.deepEqual(await readThumbnail(reader, version, images[0].assetId, 400), { version, runId: lease.runId,
        source: { media: images[0], binding: bindings(version)[0] }, thumbnail: null });
      const before = (await db.query(`SELECT row_to_json(s) AS state FROM ${c.namespace}.state s`)).rows;
      const runsBefore = (await db.query(`SELECT row_to_json(r) AS run FROM ${c.namespace}.runs r ORDER BY id`)).rows;
      await registrar.register(input); await registrar.register(input);
      const projection = await readThumbnail(reader, version, images[0].assetId, 400);
      assert.equal(projection?.runId, lease.runId); assert.deepEqual(projection?.thumbnail, input.thumbnail);
      assert.deepEqual((await db.query(`SELECT row_to_json(s) AS state FROM ${c.namespace}.state s`)).rows, before);
      assert.deepEqual((await db.query(`SELECT row_to_json(r) AS run FROM ${c.namespace}.runs r ORDER BY id`)).rows, runsBefore);
      const otherOutput = { ...input, thumbnail: thumbnail(images[0], 400, "c".repeat(64)) };
      await assert.rejects(registrar.register(otherOutput), unavailable);
      await assert.rejects(rawRegister(otherOutput), /NB_THUMBNAIL_IMMUTABLE/);
      assert.deepEqual((await readThumbnail(reader, version, images[0].assetId, 400))?.thumbnail, input.thumbnail);
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 800))?.thumbnail, null);
      await registrar.register(registration(version, lease.runId, 0, 800));
      assert.deepEqual((await readThumbnail(reader, version, images[0].assetId, 800))?.thumbnail, thumbnail(images[0], 800));
      assert.equal(await readThumbnail(reader, version, `a1.${"f".repeat(64)}`, 400), null);
    });
    await t.test("a new generation cannot read or register against old thumbnail manifests", async () => {
      const previous = await readThumbnail(reader, version, images[0].assetId, 400);
      const next = await c.publish();
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 400))?.thumbnail, null);
      await assert.rejects(registrar.register(registration(version, previous!.runId)), unavailable);
      await registrar.register(registration(version, next.runId));
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 400))?.runId, next.runId);
    });
    await t.test("missing source bindings, incorrect hashes/fingerprints and unknown parents fail closed", async () => {
      const missing = await c.publish(randomUUID(), false);
      assert.equal(await readThumbnail(reader, version, images[0].assetId, 400), null);
      await assert.rejects(registrar.register(registration(version, missing.runId)), unavailable);
      const lease = await c.publish(), input = registration(version, lease.runId);
      for (const invalid of [{ ...input, runId: randomUUID() }, { ...input, sourceSha256: "f".repeat(64) },
        { ...input, sourceFingerprint: "f".repeat(64) }, { ...input, assetId: `a1.${"f".repeat(64)}` }]) {
        await assert.rejects(rawRegister(invalid), /NB_THUMBNAIL_SOURCE_INVALID/);
      }
      await registrar.register(input);
      await db.query(`UPDATE ${version === "v1" ? "nb_media" : "nb_v2_media"}.sources SET binding=jsonb_set(binding,'{sourceFingerprint}',to_jsonb($1::text)) WHERE run_id=$2 AND asset_id=$3`, ["d".repeat(64), lease.runId, images[0].assetId]);
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 400))?.thumbnail, null);
      await assert.rejects(registrar.register(input), unavailable);
    });
    await t.test("SQL rejects malformed descriptors even when bypassing TypeScript checks", async () => {
      const lease = await c.publish(), input = registration(version, lease.runId);
      const wrongOwner = thumbnail({ ...images[0], ownerPageId: owners[1] });
      const invalid = [null, {}, { ...input.thumbnail, ownerPageId: owners[1] }, wrongOwner,
        { ...input.thumbnail, assetId: images[0].assetId }, { ...input.thumbnail, objectKey: "public/example" },
        { ...input.thumbnail, sha256: "bad" }, { ...input.thumbnail, mime: "image/png" },
        { ...input.thumbnail, byteSize: 0 }, { ...input.thumbnail, byteSize: 20971521 }, { ...input.thumbnail, byteSize: 1.5 },
        { ...input.thumbnail, width: null }, { ...input.thumbnail, width: 401 }, { ...input.thumbnail, width: 0 },
        { ...input.thumbnail, height: 0 }, { ...input.thumbnail, height: 16384 }, { ...input.thumbnail, height: "1" },
        { ...input.thumbnail, url: "https://fictional.example.test/private" }];
      for (const descriptor of invalid) await assert.rejects(rawRegister({ ...input, thumbnail: descriptor as StoredMedia }), /NB_THUMBNAIL_INVALID/);
      await assert.rejects(rawRegister({ ...input, widthCap: 200 as ThumbnailWidth }), /NB_THUMBNAIL_INVALID/);
      await assert.rejects(rawRegister({ ...input, version: "v3" as MediaSourceVersion }), /NB_THUMBNAIL_QUERY_INVALID/);
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 400))?.thumbnail, null);
      const tallest = { ...input, thumbnail: { ...input.thumbnail, height: 16383 } };
      await registrar.register(tallest);
      assert.equal((await readThumbnail(reader, version, images[0].assetId, 400))?.thumbnail?.height, 16383);
    });
    await t.test("owner and ancestor withdrawal remove thumbnails and block new registration", async () => {
      const lease = await c.publish();
      for (let index = 0; index < 3; index++) await registrar.register(registration(version, lease.runId, index));
      await db.query(`SELECT ${c.namespace}_api.set_denied($1,true)`, [owners[0]]);
      assert.equal(await readThumbnail(reader, version, images[0].assetId, 400), null);
      await assert.rejects(registrar.register(registration(version, lease.runId)), unavailable);
      assert.ok((await readThumbnail(reader, version, images[2].assetId, 400))?.thumbnail);
      await db.query(`SELECT ${c.namespace}_api.set_denied($1,true)`, [owners[1]]);
      assert.equal(await readThumbnail(reader, version, images[2].assetId, 400), null);
      await assert.rejects(registrar.register(registration(version, lease.runId, 2)), unavailable);
    });
    await t.test("expired or policy-invalid snapshots cannot be made current by thumbnail registration", async () => {
      await db.query(`SELECT ${c.namespace}_api.set_denied($1,false)`, [owners[0]]);
      await db.query(`SELECT ${c.namespace}_api.set_denied($1,false)`, [owners[1]]);
      const lease = await c.publish(); await registrar.register(registration(version, lease.runId));
      await db.query(`UPDATE ${c.namespace}.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [lease.runId]);
      await assert.rejects(readThumbnail(reader, version, images[0].assetId, 400), unavailable);
      await assert.rejects(registrar.register(registration(version, lease.runId)), unavailable);
      const fresh = await c.publish(); await registrar.register(registration(version, fresh.runId));
      await c.configure();
      await assert.rejects(readThumbnail(reader, version, images[0].assetId, 400), unavailable);
      await assert.rejects(registrar.register(registration(version, fresh.runId)), unavailable);
    });
  } finally { await db.close(); }
});

test("thumbnail namespaces remain private despite broad Supabase default grants", async () => {
  const { db, role, core, registration, worker } = await install(["v1"]);
  try {
    const c = core("v1"); await c.configure(); const lease = await c.publish(), input = registration("v1", lease.runId);
    await createThumbnailRegistrar(worker).register(input);
    for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
      const actor = role(name);
      for (const table of ["media", "migrations"]) await assert.rejects(actor.query(`SELECT * FROM nb_thumbnails.${table}`), /permission denied/);
      await assert.rejects(actor.query("CREATE TABLE nb_thumbnails.untrusted(id integer)"), /permission denied/);
      await assert.rejects(actor.query("CREATE FUNCTION nb_thumbnail_api.untrusted() RETURNS integer LANGUAGE SQL AS 'SELECT 1'"), /permission denied/);
      await assert.rejects(actor.query("SELECT nb_thumbnails.qualified_source('v1',$1)", [input.assetId]), /permission denied/);
      if (name !== "nb_reader") await assert.rejects(actor.query("SELECT nb_thumbnail_api.read_media('v1',$1,400)", [input.assetId]), /permission denied/);
      if (name !== "nb_writer") await assert.rejects(createThumbnailRegistrar(actor).register(input), unavailable);
    }
    const flags = (await db.query<{ relname: string; relrowsecurity: boolean }>("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='nb_thumbnails'::regnamespace AND relkind='r'")).rows;
    assert.deepEqual(flags.map(row => [row.relname, row.relrowsecurity]).sort(), [["media", true], ["migrations", true]]);
    const functions = (await db.query<{ prosecdef: boolean; proconfig: string[] }>("SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace IN ('nb_thumbnails'::regnamespace,'nb_thumbnail_api'::regnamespace)")).rows;
    assert.equal(functions.length, 3);
    for (const fn of functions) { assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes("search_path=pg_catalog, nb_thumbnails, pg_temp")); }
  } finally { await db.close(); }
});

test("identical parent IDs and run IDs never mix v1/v2 thumbnail generations", async () => {
  const { db, core, worker, reader, registration } = await install(["v1", "v2"]);
  try {
    const runId = randomUUID();
    for (const version of ["v1", "v2"] as const) { const c = core(version); await c.configure(); await c.publish(runId); }
    assert.equal(media("v1")[0].assetId, media("v2")[0].assetId);
    const registrar = createThumbnailRegistrar(worker), first = registration("v1", runId), second = registration("v2", runId);
    second.thumbnail = thumbnail(media("v2")[0], 400, "c".repeat(64));
    await registrar.register(first);
    assert.equal((await readThumbnail(reader, "v2", first.assetId, 400))?.thumbnail, null);
    await registrar.register(second);
    assert.deepEqual((await readThumbnail(reader, "v1", first.assetId, 400))?.thumbnail, first.thumbnail);
    assert.deepEqual((await readThumbnail(reader, "v2", first.assetId, 400))?.thumbnail, second.thumbnail);
    await db.query("SELECT nb_api.set_denied($1,true)", [owners[0]]);
    assert.equal(await readThumbnail(reader, "v1", first.assetId, 400), null);
    assert.ok((await readThumbnail(reader, "v2", first.assetId, 400))?.thumbnail);
    assert.equal(await readThumbnail(reader, "v1", media("v2")[2].assetId, 400), null);
  } finally { await db.close(); }
});

test("reader catalog audit permits thumbnail reads and rejects index writes or ownership", async t => {
  const { db } = await install(["v1", "v2"]);
  const safe = { safe_login: true, reader_only: true, create_denied: true, private_tables_denied: true, read_allowed: true, write_denied: true };
  try {
    await db.exec(await readFile(new URL("../database/reader-migrations/001_status.sql", import.meta.url), "utf8"));
    await db.exec("CREATE ROLE fixture_thumbnail_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT; GRANT nb_reader TO fixture_thumbnail_reader;");
    async function permissions() {
      await db.exec("SET SESSION AUTHORIZATION fixture_thumbnail_reader");
      try { return (await db.query<Record<string, boolean>>(READER_PERMISSIONS_SQL)).rows[0]; }
      finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
    }
    assert.deepEqual(await permissions(), safe);
    const cases = [
      ["GRANT SELECT ON nb_thumbnails.media TO fixture_thumbnail_reader", "REVOKE SELECT ON nb_thumbnails.media FROM fixture_thumbnail_reader", "private_tables_denied"],
      ["GRANT SELECT(descriptor) ON nb_thumbnails.media TO fixture_thumbnail_reader", "REVOKE SELECT(descriptor) ON nb_thumbnails.media FROM fixture_thumbnail_reader", "private_tables_denied"],
      ["GRANT SELECT ON nb_thumbnails.migrations TO fixture_thumbnail_reader", "REVOKE SELECT ON nb_thumbnails.migrations FROM fixture_thumbnail_reader", "private_tables_denied"],
      ["GRANT CREATE ON SCHEMA nb_thumbnails TO fixture_thumbnail_reader", "REVOKE CREATE ON SCHEMA nb_thumbnails FROM fixture_thumbnail_reader", "create_denied"],
      ["GRANT CREATE ON SCHEMA nb_thumbnail_api TO fixture_thumbnail_reader", "REVOKE CREATE ON SCHEMA nb_thumbnail_api FROM fixture_thumbnail_reader", "create_denied"],
      ["ALTER SCHEMA nb_thumbnails OWNER TO fixture_thumbnail_reader", "ALTER SCHEMA nb_thumbnails OWNER TO postgres", "create_denied"],
      ["ALTER SCHEMA nb_thumbnail_api OWNER TO nb_reader", "ALTER SCHEMA nb_thumbnail_api OWNER TO postgres; GRANT USAGE ON SCHEMA nb_thumbnail_api TO nb_reader,nb_writer", "create_denied"],
      ["GRANT EXECUTE ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) TO fixture_thumbnail_reader", "REVOKE EXECUTE ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) FROM fixture_thumbnail_reader", "write_denied"],
      ["GRANT EXECUTE ON FUNCTION nb_thumbnails.qualified_source(text,text) TO fixture_thumbnail_reader", "REVOKE EXECUTE ON FUNCTION nb_thumbnails.qualified_source(text,text) FROM fixture_thumbnail_reader", "write_denied"],
      ["REVOKE EXECUTE ON FUNCTION nb_thumbnail_api.read_media(text,text,integer) FROM nb_reader", "GRANT EXECUTE ON FUNCTION nb_thumbnail_api.read_media(text,text,integer) TO nb_reader", "read_allowed"],
    ];
    for (const [grant, revoke, key] of cases) await t.test(key, async () => {
      await db.exec(grant);
      try { assert.equal((await permissions())[key], false); }
      finally { await db.exec(revoke); }
    });
    assert.deepEqual(await permissions(), safe);
  } finally { await db.close(); }
});

test("thumbnail adapter rejects malformed private envelopes and sanitizes upstream errors", async () => {
  const parent = media("v1")[0], runId = randomUUID();
  const projection = { thumbnailCapability: THUMBNAIL_CAPABILITY, schemaDigest: SYNC_SCHEMA_DIGEST, version: "v1", runId,
    source: { media: parent, binding: bindings("v1")[0] }, thumbnail: thumbnail(parent) };
  const fake = (result: unknown): SqlExecutor => ({ async query<T>() { return { rows: [{ result }] as T[] }; } });
  for (const invalid of [{ ...projection, thumbnailCapability: "wrong" }, { ...projection, schemaDigest: WEBSITE_SCHEMA_DIGEST },
    { ...projection, version: "v2" }, { ...projection, runId: "wrong" }, { ...projection, source: null },
    { ...projection, source: { ...projection.source, media: null } }, { ...projection, source: { ...projection.source, binding: null } },
    { ...projection, source: { ...projection.source, binding: { ...projection.source.binding, ownerPageId: owners[1] } } },
    { ...projection, thumbnail: thumbnail({ ...parent, ownerPageId: owners[1] }) }, { ...projection, thumbnail: { ...projection.thumbnail, mime: "image/png" } },
    { ...projection, thumbnail: { ...projection.thumbnail, height: null } }, { ...projection, privateUrl: "https://fictional.example.test/private" }]) {
    await assert.rejects(readThumbnail(fake(invalid), "v1", parent.assetId, 400), unavailable);
  }
  const failed: SqlExecutor = { async query() { throw new Error("private connection detail"); } };
  await assert.rejects(readThumbnail(failed, "v1", parent.assetId, 400), error => unavailable(error) && !String(error).includes("private connection detail"));
  const input: ThumbnailRegistration = { version: "v1", runId, assetId: parent.assetId, sourceSha256: parent.sha256,
    sourceFingerprint: fingerprint, widthCap: 400, thumbnail: thumbnail(parent) };
  let called = false;
  const untouched: SqlExecutor = { async query() { called = true; throw new Error(); } };
  for (const invalid of [{ ...input, version: "wrong" }, { ...input, runId: "wrong" }, { ...input, assetId: "wrong" },
    { ...input, sourceSha256: "wrong" }, { ...input, sourceFingerprint: "wrong" }, { ...input, widthCap: 200 },
    { ...input, thumbnail: { ...input.thumbnail, width: 401 } }, { ...input, thumbnail: { ...input.thumbnail, height: 16384 } },
    { ...input, thumbnail: { ...input.thumbnail, mime: "image/png" } },
    { ...input, privateUrl: "https://fictional.example.test/private" }]) {
    await assert.rejects(createThumbnailRegistrar(untouched).register(invalid as ThumbnailRegistration), unavailable);
  }
  assert.equal(called, false);
  assert.equal(await readThumbnail(untouched, "v1", "bad", 400), null);
  assert.equal(await readThumbnail(untouched, "v1", parent.assetId, 200 as ThumbnailWidth), null);
});


test("course-cover extension limits 1600 to current v2 course covers and preserves expiry writes", async () => {
  const { db, core, reader, worker, registration, rawRegister } = await install(["v1", "v2"]);
  try {
    const { migrateCourseCoverThumbnails, verifyCourseCoverThumbnailProtocol } = await import("../scripts/media-thumbnails/course-cover-migrate.ts");
    const admin: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes("CREATE TABLE nb_thumbnails.extensions")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await assert.rejects(migrateCourseCoverThumbnails(admin));
    await db.exec(await readFile(new URL("../supabase/migrations/20261016121202_website_last_success.sql", import.meta.url), "utf8"));
    const wrapper = (await db.query("SELECT pg_get_functiondef('nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb)'::regprocedure) AS definition")).rows;
    assert.equal((await migrateCourseCoverThumbnails(admin)).installed, true);
    assert.equal((await migrateCourseCoverThumbnails(admin)).installed, false);
    await verifyCourseCoverThumbnailProtocol();
    assert.deepEqual((await db.query("SELECT pg_get_functiondef('nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb)'::regprocedure) AS definition")).rows, wrapper);
    const c = core("v2"); await c.configure(); const lease = await c.publish();
    const input = registration("v2", lease.runId, 1, 1600);
    input.thumbnail.width = 1600; input.thumbnail.height = 900;
    await assert.rejects(rawRegister(input)); // Source supplies only one pixel.
    await db.query("UPDATE nb_v2.media SET descriptor=descriptor||'{\"width\":1672,\"height\":941}'::jsonb WHERE run_id=$1", [lease.runId]);
    const registrar = createThumbnailRegistrar(worker);
    await assert.rejects(rawRegister({ ...input, thumbnail: { ...input.thumbnail, height: 942 } }));
    await registrar.register(input);
    assert.deepEqual((await readThumbnail(reader, "v2", input.assetId, 1600))?.thumbnail, input.thumbnail);
    await assert.rejects(rawRegister({ ...input, sourceSha256: "0".repeat(64) }));
    await assert.rejects(rawRegister({ ...input, sourceFingerprint: "0".repeat(64) }));
    for (const index of [0, 2]) {
      const wrong = registration("v2", lease.runId, index, 1600); wrong.thumbnail.width = 1600;
      await assert.rejects(rawRegister(wrong));
      assert.equal(await readThumbnail(reader, "v2", wrong.assetId, 1600), null);
    }
    await registrar.register(registration("v2", lease.runId)); // Old 400 still works.
    await db.exec("UPDATE nb_availability.policy SET retain_last_success=true");
    await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
    assert.ok((await readThumbnail(reader, "v2", input.assetId, 1600))?.thumbnail);
    await assert.rejects(rawRegister(input));
    await db.query("SELECT nb_v2_api.set_denied($1,true)", [owners[1]]);
    assert.equal(await readThumbnail(reader, "v2", input.assetId, 1600), null);
    const v1 = core("v1"); await v1.configure(); const old = await v1.publish();
    await registrar.register(registration("v1", old.runId));
    await assert.rejects(rawRegister(registration("v1", old.runId, 1, 1600)));
    for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
      const actor = { query: <T>(sql: string) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql); }) };
      await assert.rejects(actor.query("SELECT * FROM nb_thumbnails.extensions"));
      await assert.rejects(actor.query("SELECT nb_availability.register_qualified_legacy(NULL,NULL,NULL,NULL,NULL,NULL,NULL)"));
    }
  } finally { await db.close(); }
});


test("body-image extension rebinds only referenced authorized images and keeps old installers and expiry guards", async () => {
  const { db, core, reader, worker, registration } = await install(["v1", "v2"]);
  try {
    const { migrateCourseCoverThumbnails } = await import("../scripts/media-thumbnails/course-cover-migrate.ts");
    const { migrateBodyImageThumbnails } = await import("../scripts/media-thumbnails/body-image-migrate.ts");
    const { continueBodyThumbnails } = await import("../scripts/media-thumbnails/body-image-continuation.ts");
    const admin: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes("CREATE TABLE nb_thumbnails.")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await assert.rejects(migrateBodyImageThumbnails(admin));
    await db.exec(await readFile(new URL("../supabase/migrations/20261016121202_website_last_success.sql", import.meta.url), "utf8"));
    await migrateCourseCoverThumbnails(admin);
    assert.equal((await migrateBodyImageThumbnails(admin)).installed, true);
    assert.equal((await migrateBodyImageThumbnails(admin)).installed, false);
    assert.equal((await migrateCourseCoverThumbnails(admin)).installed, false);
    const c = core("v2"); await c.configure(); const lease = await c.publish();
    const parent = media("v2")[2], image = { id: parent.assetId, src: `/media/v2/${parent.assetId}`, alt: "Fictional body image", width: 1672, height: 941 };
    const document = { ...body, blocks: [{ type: "toggle", id: id(30), title: [], children: [{ type: "image", id: `block-${createHash("sha256").update(id(20)).digest("hex").slice(0,24)}`, image, caption: [] }] }] };
    await db.query("UPDATE nb_v2.records SET item=jsonb_set(item,'{cover}','null'),document=$1::jsonb WHERE run_id=$2 AND id=$3", [JSON.stringify(document), lease.runId, owners[2]]);
    await db.query("UPDATE nb_v2.media SET descriptor=descriptor||'{\"width\":1672,\"height\":941,\"byteSize\":4096}'::jsonb WHERE run_id=$1", [lease.runId]);
    const input = registration("v2", lease.runId, 2, 1600); input.thumbnail.width = 1600; input.thumbnail.height = 900;
    const source = (await readThumbnail(reader, "v2", parent.assetId, 1600))!.source;
    const candidate = { source, thumbnail: input.thumbnail, proof: { independentReaderVerified: true as const, sha256: input.thumbnail.sha256, byteSize: input.thumbnail.byteSize, mime: "image/webp" as const } };
    const run = () => continueBodyThumbnails({ runId: lease.runId, candidates: [candidate], reader, writer: worker });
    const before = (await db.query("SELECT row_to_json(s) AS state FROM nb_v2.state s")).rows;
    assert.deepEqual(await run(), { registered: 1, alreadyPresent: 0, excluded: 0, changed: 0 });
    assert.deepEqual(await run(), { registered: 0, alreadyPresent: 1, excluded: 0, changed: 0 });
    assert.deepEqual((await db.query("SELECT row_to_json(s) AS state FROM nb_v2.state s")).rows, before);
    const next = await c.publish();
    await db.query("UPDATE nb_v2.records SET item=jsonb_set(item,'{cover}','null'),document=$1::jsonb WHERE run_id=$2 AND id=$3", [JSON.stringify(document), next.runId, owners[2]]);
    await db.query("UPDATE nb_v2.media SET descriptor=descriptor||'{\"width\":1672,\"height\":941,\"byteSize\":4096}'::jsonb WHERE run_id=$1", [next.runId]);
    await assert.rejects(run(), /generation or source changed/);
    assert.deepEqual(await continueBodyThumbnails({ runId: next.runId, candidates: [candidate], reader, writer: worker }), { registered: 1, alreadyPresent: 0, excluded: 0, changed: 0 });
    for (const kind of ["album", "game", "movie", "book", "status", "study-note"]) {
      await db.query("UPDATE nb_v2.records SET kind=$1 WHERE run_id=$2 AND id=$3", [kind, next.runId, owners[2]]);
      // Scope evidence must match its kind; the existing eligibility guard still decides visibility.
      const projection = await db.query<{ allowed: boolean }>("SELECT nb_thumbnails.image_1600_allowed($1::jsonb,$2) AS allowed", [JSON.stringify({ runId: next.runId, source }), parent.assetId]);
      assert.equal(projection.rows[0].allowed, true, kind);
    }
    for (const kind of ["page", "post", "project", "course"]) {
      await db.query("UPDATE nb_v2.records SET kind=$1 WHERE run_id=$2 AND id=$3", [kind, next.runId, owners[2]]);
      assert.equal((await db.query<{ allowed: boolean }>("SELECT nb_thumbnails.image_1600_allowed($1::jsonb,$2) AS allowed", [JSON.stringify({ runId: next.runId, source }), parent.assetId])).rows[0].allowed, false, kind);
    }
    await db.query("UPDATE nb_v2.records SET kind='study-note',document=$1::jsonb WHERE run_id=$2 AND id=$3", [JSON.stringify(body), next.runId, owners[2]]);
    assert.equal(await readThumbnail(reader, "v2", parent.assetId, 1600), null);
    await db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id=$3", [JSON.stringify(document), next.runId, owners[2]]);
    await db.query("SELECT nb_v2_api.set_denied($1,true)", [owners[1]]);
    assert.equal(await readThumbnail(reader, "v2", parent.assetId, 1600), null);
    for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
      const actor: SqlExecutor = { query: <T>(sql: string) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql); }) };
      await assert.rejects(actor.query("SELECT * FROM nb_thumbnails.body_extensions"));
      await assert.rejects(actor.query("SELECT nb_thumbnails.image_1600_allowed(NULL,NULL)"));
    }
  } finally { await db.close(); }
});
