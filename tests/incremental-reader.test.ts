import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { createIncrementalPublisher, preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { readPublishedRecord, verifyIncrementalReader, verifyPublishedDelta } from "../src/server/database/incremental-reader.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import readerProtocol from "../database/incremental-reader-protocol.json" with {type: "json"};
import type { SqlExecutor } from "../src/server/database/sql.ts";

const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
test("private bounded reader confirms actual publication before acknowledgement", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
    const owner: SqlExecutor = {query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("--")) { await db.exec(sql); return {rows: [] as T[]}; }
      return db.query<T>(sql, values);
    }};
    await installPublication(owner); await installIncrementalPublication(owner);
    await db.exec("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
    const role = (name: string): SqlExecutor => ({query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    })});
    const reader = role("nb_reader"), writer = role("nb_writer"), publisher = createIncrementalPublisher(writer);
    await assert.rejects(verifyIncrementalReader(reader), code("DELTA_READER_UNAVAILABLE"));
    await installIncrementalReader(owner); await installIncrementalReader(owner); await verifyIncrementalReader(reader);
    assert.equal((await db.query<{run_id: string | null}>("SELECT run_id FROM nb_publication.state")).rows[0].run_id, null);
    const course = structuredClone(fixtureItems.course[0]), note = structuredClone(fixtureItems["study-note"][0]);
    Object.assign(note, {id: "private-note", slug: "private-note", courseId: course.id, parentId: null,
      href: `/study/${course.id}/notes/private-note`, breadcrumbs: []});
    const records: WebsiteRecord[] = [structuredClone(fixtureItems.post[0]), structuredClone(fixtureItems.post[1]), course, note].map((item, ordinal) => {
      item.cover = null;
      return {detail: {item, document: {blocks: [{id: "body", type: "paragraph", text: [{text: `Private body ${item.id}`}]}], toc: [], completeness: "complete"}},
        evidence: {sourceKey: item.kind === "study-note" ? "notes" : item.kind,
          dataSourceId: item.kind === "post" ? "fictional-posts" : "fictional-courses", databaseParentId: null,
          courseId: item.kind === "study-note" ? course.id : null, parentId: item.kind === "study-note" ? course.id : null, ordinal}};
    });
    const sources = [{key: "post", kind: "post", mode: "all", dataSourceId: "fictional-posts", databaseParentId: null, pageId: null},
      {key: "course", kind: "course", mode: "all", dataSourceId: "fictional-courses", databaseParentId: null, pageId: null},
      {key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: "fictional-courses", databaseParentId: null, pageId: null}];
    const digest = configDigest(sources);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    const sha = createHash("sha256").update("stored fixture bytes").digest("hex"), pageId = records[0].detail.item.id;
    const assetId = mediaIdentity(pageId, "cover", sha), media = {assetId, ownerPageId: pageId, sha256: sha,
      objectKey: `sha256/${sha}`, byteSize: 20, mime: "image/png" as const, width: 1, height: 1};
    records[0].detail.item.cover = {id: assetId, src: `/media/v2/${assetId}`, alt: "Stored fixture", width: 1, height: 1};
    const full = publicationWriter(writer, "published"), lease = await full.begin(randomUUID(), digest);
    await full.stage(lease, records, [media]); await full.promote(lease, {records: records.length, media: 1, complete: true});
    const current = () => publisher.state();
    const read = async (id: string, sourceKey = "post") => readPublishedRecord(reader, {pageId: id, sourceKey, expectedRevision: (await current()).publicationRevision});
    const delta = async (upserts: WebsiteRecord[], withdrawals: {id: string; sourceKey: string; reason: "deleted"}[] = []) =>
      preparePublicationDelta({expectedRevision: (await current()).publicationRevision, configDigest: digest, upserts, withdrawals, media: []});
    await t.test("one page returns reusable evidence and only its media, including course ownership", async () => {
      const result = await read(pageId); assert.ok(result);
      assert.deepEqual(result.record, records[0]); assert.deepEqual(result.media, [media]);
      assert.equal(result.readerVerified, true); assert.equal(result.schemaDigest, WEBSITE_SCHEMA_DIGEST);
      assert.ok(!JSON.stringify(result).includes(records[1].detail.item.id));
      assert.deepEqual((await read(note.id, "notes"))?.record, records[3]);
      assert.equal(await read(pageId, "notes"), null); assert.equal(await read("absent"), null);
    });
    await t.test("lost writer reply is recovered and independently verified after the qualified window", async () => {
      await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
      const changed = structuredClone(records[0]); changed.detail.item.title = "Changed once";
      const prepared = await delta([changed]), operationId = randomUUID();
      const losing: SqlExecutor = {query: async <T>(sql: string, values?: unknown[]) => {
        const result = await writer.query<T>(sql, values);
        if (sql.includes("apply_delta")) throw Object.assign(new Error("NB_DELTA_VERSION_CHANGED"), {code: "ECONNRESET"});
        return result;
      }};
      await assert.rejects(createIncrementalPublisher(losing).publish(operationId, prepared), code("DELTA_UNAVAILABLE"));
      const receipt = await publisher.lookup(operationId, prepared.payloadDigest); assert.ok(receipt);
      assert.equal(await verifyPublishedDelta(reader, receipt), true);
      assert.equal((await read(pageId))?.record.detail.item.title, "Changed once");
      assert.deepEqual((await read(records[1].detail.item.id))?.record, records[1]);
      assert.equal(await verifyPublishedDelta(reader, {...receipt, payloadDigest: "f".repeat(64)}), false);
      assert.equal(await verifyPublishedDelta(reader, {...receipt, publicationRevision: `${operationId}:999999`}), false);
      await db.transaction(async tx => {
        await tx.query("UPDATE nb_v2.records SET document='{}' WHERE run_id=$1 AND id=$2", [operationId, pageId]);
        const proof = (await tx.query<{result: unknown}>("SELECT nb_delta_api.verify_operation($1,$2,$3) AS result", [operationId, prepared.payloadDigest, receipt.publicationRevision])).rows[0].result;
        assert.equal(proof, null);
        throw new Error("rollback-fixture");
      }).catch(e => { assert.equal(e.message, "rollback-fixture"); });
      assert.equal(await verifyPublishedDelta(reader, receipt), true);
    });
    await t.test("withdrawal proof and later generations do not blindly acknowledge old results", async () => {
      const old = await publisher.publish(randomUUID(), await delta([records[1]]));
      const withdrawal = await publisher.publish(randomUUID(), await delta([], [{id: records[1].detail.item.id, sourceKey: "post", reason: "deleted"}]));
      assert.equal(await verifyPublishedDelta(reader, withdrawal), true); assert.equal(await read(records[1].detail.item.id), null);
      assert.equal(await verifyPublishedDelta(reader, old), false);
      const stale = (await current()).publicationRevision;
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [course.id]);
      assert.equal(await read(note.id, "notes"), null);
      assert.equal(await verifyPublishedDelta(reader, withdrawal), false);
      await assert.rejects(readPublishedRecord(reader, {pageId, sourceKey: "post", expectedRevision: stale}), code("DELTA_VERSION_CHANGED"));
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [course.id]);
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [pageId]); assert.equal(await read(pageId), null);
    });
    await t.test("worker projection is unavailable to writer, anonymous and broad default roles", async () => {
      await db.exec("GRANT USAGE ON SCHEMA nb_delta_api TO anon,authenticated,service_role;");
      for (const name of ["nb_writer", "anon", "authenticated", "service_role"]) {
        const restricted = role(name);
        await assert.rejects(restricted.query("SELECT nb_delta_api.check_reader($1)", [readerProtocol.migration.sha256]), /permission denied/);
        await assert.rejects(restricted.query("SELECT nb_delta_api.read_page($1,'post',$2)", [pageId, (await current()).publicationRevision]), /permission denied/);
        await assert.rejects(restricted.query("SELECT nb_delta_api.verify_operation($1,$2,$3)", [randomUUID(), "a".repeat(64), "absent"]), /permission denied/);
      }
      await assert.rejects(reader.query("SELECT * FROM nb_delta.operations"), /permission denied/);
      await assert.rejects(reader.query("SELECT nb_delta_api.read_operation($1,$2)", [randomUUID(), "a".repeat(64)]), /permission denied/);
      await publisher.publish(randomUUID(), await delta([records[1]])); // reader installation did not revoke writer mutation/recovery.
    });
    await t.test("migration mismatch cannot replace a registered reader implementation", async () => {
      await db.query("UPDATE nb_delta.state SET reader_digest=$1", ["f".repeat(64)]);
      await assert.rejects(installIncrementalReader(owner), /Installed reader migration differs/);
      await assert.rejects(verifyIncrementalReader(reader), code("DELTA_READER_UNAVAILABLE"));
    });
  } finally { await db.close(); }
});

test("reader rejects invalid input, cancellation and malformed proofs without leaking transport errors", async () => {
  const unused: SqlExecutor = {query: async () => { assert.fail("Must not query for invalid input"); }};
  await assert.rejects(readPublishedRecord(unused, {pageId: undefined as unknown as string, sourceKey: "post", expectedRevision: `${randomUUID()}:1`}), code("DELTA_INPUT_INVALID"));
  await assert.rejects(verifyPublishedDelta(unused, {operationId: randomUUID(), payloadDigest: "a".repeat(64), publicationRevision: `${randomUUID()}:1`, committed: true}), code("DELTA_INPUT_INVALID"));
  await assert.rejects(verifyIncrementalReader(unused, AbortSignal.abort()), {name: "AbortError"});
  const bad: SqlExecutor = {query: async <T>(sql: string) => {
    if (sql.includes("check_")) return {rows: [{result: true}] as T[]};
    return {rows: [{result: {readerVerified: true}}] as T[]};
  }};
  await assert.rejects(verifyPublishedDelta(bad, {operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", payloadDigest: "a".repeat(64), publicationRevision: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1", committed: true}), code("DELTA_READER_UNAVAILABLE"));
  const transport: SqlExecutor = {query: async () => { throw new Error("private connection string"); }};
  await assert.rejects(verifyIncrementalReader(transport), error => error instanceof Error && !error.message.includes("private connection string"));
});
