import { withPGliteOwnerTransaction } from "../scripts/website-sync/owner-install-session.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { AnyContent, StudyNote } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { websiteMediaResponse } from "../src/server/database/website-media.ts";
import { createIncrementalPublisher, preparePublicationDelta, readPublicationState, type PublicationDelta } from "../src/server/database/incremental-publication.ts";
import { installIncrementalWithdrawalRecovery } from "../scripts/website-sync/incremental-withdrawal-recovery.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const code = (expected: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === expected;
test("atomic deltas preserve independent publication, media and recovery without source reads", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
    const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("-- Opt-in")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await installPublication(operator);
    await db.exec("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
    await installIncrementalPublication(operator); await installIncrementalPublication(operator);
    await withPGliteOwnerTransaction(db, installIncrementalWithdrawalRecovery); await withPGliteOwnerTransaction(db, installIncrementalWithdrawalRecovery);
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const reader = role("nb_reader"), publisher = createIncrementalPublisher(role("nb_writer"));
    const repo = createWebsiteDatabaseRepository(publicationReader(reader, "published"));
    await assert.rejects(publisher.state(), code("DELTA_UNAVAILABLE"));
    const course1 = structuredClone(fixtureItems.course[0]), course2 = structuredClone(course1);
    course2.id = "other-course"; course2.slug = "other-course"; course2.href = "/study/other-course";
    const note1 = structuredClone(fixtureItems["study-note"][0]), note2 = structuredClone(note1);
    Object.assign(note1, { id: "note-root", slug: "note-root", courseId: course1.id, parentId: null, breadcrumbs: [], href: `/study/${course1.id}/notes/note-root` });
    Object.assign(note2, { id: "note-child", slug: "note-child", courseId: course1.id, parentId: note1.id, breadcrumbs: [], href: `/study/${course1.id}/notes/note-child` });
    const items: AnyContent[] = [structuredClone(fixtureItems.post[0]), structuredClone(fixtureItems.post[1]), course1, course2, note1, note2];
    const batch: WebsiteRecord[] = items.map((item, ordinal) => {
      item.cover = null;
      const note = item.kind === "study-note";
      return { detail: { item, document: { blocks: [{ id: "body", type: "paragraph", text: [{ text: `Body ${item.id}` }] }], toc: [], completeness: "complete" } },
        evidence: { sourceKey: note ? "notes" : item.kind, dataSourceId: note || item.kind === "course" ? "source-courses" : "source-posts",
          databaseParentId: null, courseId: note ? item.courseId : null, parentId: note ? item.parentId ?? item.courseId : null, ordinal } };
    });
    const sources = [{ key: "post", kind: "post", mode: "all", dataSourceId: "source-posts", databaseParentId: null, pageId: null },
      { key: "course", kind: "course", mode: "all", dataSourceId: "source-courses", databaseParentId: null, pageId: null },
      { key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: "source-courses", databaseParentId: null, pageId: null }];
    const digest = configDigest(sources);
    const configure = () => db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    await configure();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
    const sha = createHash("sha256").update(bytes).digest("hex"), owner = items[0].id, assetId = mediaIdentity(owner, "cover", sha);
    const media = { assetId, ownerPageId: owner, objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png" as const, width: 1, height: 1 };
    batch[0].detail.item.cover = { id: assetId, src: `/media/v2/${assetId}`, alt: "Stored fixture", width: 1, height: 1 };
    const full = publicationWriter(role("nb_writer"), "published"), baseline = await full.begin(randomUUID(), digest);
    await full.stage(baseline, batch, [media]); await full.promote(baseline, { records: batch.length, media: 1, complete: true });
    const change = async (upserts: WebsiteRecord[], withdrawals: PublicationDelta["withdrawals"] = [], preparedMedia: PublicationDelta["media"] = []) =>
      preparePublicationDelta({ expectedRevision: (await publisher.state()).publicationRevision, configDigest: digest, upserts, withdrawals, media: preparedMedia });
    const record = (id: string) => structuredClone(batch.find(r => r.detail.item.id === id)!);
    await t.test("single page update sends one body, reuses old media and keeps unrelated bodies", async () => {
      const before = await repo.get("post", items[1].slug), changed = record(owner); changed.detail.item.title = "Updated only one page";
      await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [baseline.runId]);
      const delta = await change([changed]), operation = randomUUID(), result = await publisher.publish(operation, delta);
      assert.equal(result.upserts, 1); assert.equal(result.records, batch.length); assert.equal(result.media, 1);
      assert.equal((await db.query<{current_run: string}>("SELECT current_run FROM nb_v2.state")).rows[0].current_run, baseline.runId);
      await assert.rejects(createWebsiteDatabaseRepository(reader).list("post"), code("CONTENT_UNAVAILABLE"));
      assert.equal((await db.query<{expired: boolean}>("SELECT valid_until<=clock_timestamp() AS expired FROM nb_v2.runs WHERE id=$1", [operation])).rows[0].expired, true);
      assert.deepEqual(await repo.get("post", items[1].slug), before);
      assert.equal((await repo.get("post", items[0].slug))?.item.title, changed.detail.item.title);
      const response = await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => ({ read: async () => bytes, put: async () => assert.fail("No media upload") }));
      assert.equal(response.status, 200);
      assert.deepEqual(await publisher.lookup(operation, delta.payloadDigest), result);
      assert.deepEqual(await publisher.publish(operation, delta), result);
      assert.equal((await db.query<{n: number}>("SELECT count(*)::int AS n FROM nb_delta.operations")).rows[0].n, 1);
      const tampered = structuredClone(delta); tampered.upserts[0].detail.item.title = "Tampered";
      await assert.rejects(publisher.publish(operation, tampered), code("DELTA_OPERATION_CONFLICT"));
      const rebound = preparePublicationDelta(tampered);
      await assert.rejects(publisher.publish(operation, rebound), code("DELTA_OPERATION_CONFLICT"));
      await assert.rejects(role("nb_writer").query("SELECT nb_delta_api.apply_delta($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)",
        [operation, delta.payloadDigest, delta.expectedRevision, digest, JSON.stringify(rebound.upserts), "[]", "[]"]), /NB_DELTA_OPERATION_CONFLICT/);
    });
    await t.test("deny across deltas retains private rows and restores all-source content, subtrees and media", async () => {
      for (const denied of [owner, course1.id, note1.id]) {
        const before = await repo.list("study-note");
        await db.query("SELECT nb_v2_api.set_denied($1,true)", [denied]);
        const publicKind = denied === owner ? "post" : denied === course1.id ? "course" : "study-note";
        const slug = batch.find(r => r.detail.item.id === denied)!.detail.item.slug;
        assert.equal(await repo.get(publicKind, slug), null);
        const result = await publisher.publish(randomUUID(), await change([record(items[1].id)]));
        assert.equal(result.records, batch.length); assert.equal(result.media, 1);
        assert.equal(await repo.get(publicKind, slug), null);
        if (denied === owner) {
          const hidden = await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => assert.fail("No storage read for denied owner"));
          assert.equal(hidden.status, 404);
        } else assert.equal((await repo.list("study-note")).total, 0);
        // A new write to the denied page is still rejected, with no pointer change.
        const state = await publisher.state();
        await assert.rejects(publisher.publish(randomUUID(), await change([record(denied)])), code("DELTA_INPUT_INVALID"));
        assert.deepEqual(await publisher.state(), state);
        await db.query("SELECT nb_v2_api.set_denied($1,false)", [denied]);
        assert.ok(await repo.get(publicKind, slug));
        assert.equal((await repo.list("study-note")).total, before.total);
        await publisher.publish(randomUUID(), await change([record(items[1].id)]));
      }
      assert.equal((await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => ({ read: async () => bytes, put: async () => assert.fail() }))).status, 200);
      // A deny must not hide corruption of the accepted ancestor chain.
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [course1.id]);
      const current = (await publisher.state()).publicationRevision.split(":")[0];
      await db.query("UPDATE nb_v2.records SET parent_id=$1,item=jsonb_set(item,'{parentId}',to_jsonb($1::text)) WHERE run_id=$2 AND id=$3", [note2.id, current, note1.id]);
      const beforeCycle = await publisher.state();
      await assert.rejects(publisher.publish(randomUUID(), await change([record(items[1].id)])), code("DELTA_INPUT_INVALID"));
      assert.deepEqual(await publisher.state(), beforeCycle);
      await db.query("UPDATE nb_v2.records SET parent_id=$1,item=jsonb_set(item,'{parentId}','null'::jsonb) WHERE run_id=$2 AND id=$3", [course1.id, current, note1.id]);
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [course1.id]);
      // Denial cannot turn a proven source deletion into a restorable snapshot.
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [note1.id]);
      await publisher.publish(randomUUID(), await change([], [{ id: note1.id, sourceKey: "notes", reason: "deleted" }]));
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [note1.id]);
      assert.equal((await repo.list("study-note")).total, 0);
      await publisher.publish(randomUUID(), await change([record(note1.id), record(note2.id)]));
    });
    await t.test("lost response recovers by operation ID after another publication", async () => {
      const delta = await change([record(items[1].id)]), operation = randomUUID();
      const losing: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
        const result = await role("nb_writer").query<T>(sql, values);
        if (sql.includes("apply_delta")) throw new Error("Connection lost after commit"); return result;
      } };
      await assert.rejects(createIncrementalPublisher(losing).publish(operation, delta), code("DELTA_UNAVAILABLE"));
      const committed = await publisher.lookup(operation, delta.payloadDigest); assert.ok(committed);
      await publisher.publish(randomUUID(), await change([record(owner)]));
      assert.deepEqual(await publisher.publish(operation, delta), committed);
      await assert.rejects(publisher.lookup(operation, "f".repeat(64)), code("DELTA_OPERATION_CONFLICT"));
      assert.equal(await publisher.lookup(randomUUID(), delta.payloadDigest), null);
    });
    await t.test("stale tasks and an active full publisher cannot overwrite a newer version", async () => {
      const stale = await change([record(owner)]); await publisher.publish(randomUUID(), stale);
      await assert.rejects(publisher.publish(randomUUID(), stale), code("DELTA_VERSION_CHANGED"));
      const fresh = await change([record(owner)]), lease = await full.begin(randomUUID(), digest);
      await assert.rejects(publisher.publish(randomUUID(), fresh), code("BUSY")); await full.fail(lease);
    });
    await t.test("incomplete media or missing body rolls back all rows, pointer and receipt", async () => {
      const bad = record(owner), missing = `a1.${"f".repeat(64)}`;
      bad.detail.item.cover = { id: missing, src: `/media/v2/${missing}`, alt: "Missing stored media", width: 1, height: 1 };
      const before = await publisher.state(), operation = randomUUID(), delta = await change([bad]);
      await assert.rejects(publisher.publish(operation, delta), code("DELTA_INPUT_INVALID"));
      assert.deepEqual(await publisher.state(), before); assert.equal(await publisher.lookup(operation, delta.payloadDigest), null);
      assert.equal((await db.query("SELECT id FROM nb_v2.runs WHERE id=$1", [operation])).rows.length, 0);
      bad.detail.document = null; await assert.rejects(change([bad]), code("DELTA_INPUT_INVALID"));
    });
    await t.test("parent moves require descendants, then update both course trees atomically", async () => {
      const parent = record(note1.id), child = record(note2.id);
      for (const r of [parent, child]) {
        const item = r.detail.item as StudyNote; item.courseId = course2.id; item.href = `/study/${course2.id}/notes/${item.slug}`;
        r.evidence.courseId = course2.id; if (r === parent) r.evidence.parentId = course2.id;
      }
      const before = await publisher.state();
      await assert.rejects(publisher.publish(randomUUID(), await change([parent])), code("DELTA_DEPENDENCY_MISSING"));
      assert.deepEqual(await publisher.state(), before);
      await publisher.publish(randomUUID(), await change([parent, child]));
      assert.equal((await repo.getCourseTree(course1.slug))?.nodes.length, 0);
      const moved = await repo.getCourseTree(course2.slug); assert.equal(moved?.nodes.length, 1);
      assert.equal(moved?.nodes[0].children?.length, 1);
    });
    await t.test("confirmed subtree withdrawal removes children and independent media eligibility", async () => {
      const result = await publisher.publish(randomUUID(), await change([], [{ id: note1.id, sourceKey: "notes", reason: "deleted" }]));
      assert.equal(result.removedRecords, 2); assert.equal((await repo.list("study-note")).total, 0);
      await publisher.publish(randomUUID(), await change([record(note1.id), record(note2.id)]));
      const moved = record(note2.id), movedItem = moved.detail.item as StudyNote;
      movedItem.courseId = course2.id; movedItem.parentId = null; movedItem.href = `/study/${course2.id}/notes/${movedItem.slug}`;
      moved.evidence.courseId = course2.id; moved.evidence.parentId = course2.id;
      const retained = await publisher.publish(randomUUID(), await change([moved], [{ id: note1.id, sourceKey: "notes", reason: "out-of-scope" }]));
      assert.equal(retained.removedRecords, 1); assert.equal((await repo.list("study-note")).total, 1);
      await assert.rejects(publisher.publish(randomUUID(), await change([], [{ id: owner, sourceKey: "notes", reason: "deleted" }])), code("DELTA_WITHDRAWAL_INVALID"));
      const clearImage = record(owner); clearImage.detail.item.cover = null;
      await publisher.publish(randomUUID(), await change([clearImage]));
      const response = await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => { assert.fail("Removed references must not read objects"); });
      assert.equal(response.status, 404);
    });
    await t.test("central deny, policy changes and role separation remain mandatory", async () => {
      const pending = await change([record(owner)]); await db.query("SELECT nb_v2_api.set_denied($1,true)", [owner]);
      await assert.rejects(publisher.publish(randomUUID(), pending), code("DELTA_VERSION_CHANGED"));
      assert.equal(await repo.get("post", items[0].slug), null); await db.query("SELECT nb_v2_api.set_denied($1,false)", [owner]);
      assert.equal((await readPublicationState(reader)).schemaDigest, WEBSITE_SCHEMA_DIGEST);
      for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
        await assert.rejects(role(name).query("SELECT * FROM nb_delta.operations"), /permission denied/);
      }
      await db.exec("GRANT USAGE ON SCHEMA nb_delta,nb_delta_api TO anon,authenticated,service_role");
      for (const name of ["anon", "authenticated", "service_role"]) {
        await assert.rejects(role(name).query("SELECT * FROM nb_delta.operations"), /permission denied/);
        await assert.rejects(role(name).query("SELECT nb_delta_api.read_state()"), /permission denied/);
      }
      await assert.rejects(reader.query("SELECT nb_delta_api.read_operation($1,$2)", [randomUUID(), "a".repeat(64)]), /permission denied/);
      await configure(); await assert.rejects(publisher.state(), code("DELTA_UNAVAILABLE"));
    });
  } finally { await db.close(); }
});

test("explicit allowlist withdrawals retain tombstones and cannot bypass publication completeness", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("-- Opt-in")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await installPublication(operator); await installIncrementalPublication(operator);
    await withPGliteOwnerTransaction(db, installIncrementalWithdrawalRecovery);
    const batch: WebsiteRecord[] = fixtureItems.post.slice(0, 2).map((raw, ordinal) => {
      const item = structuredClone(raw); item.cover = null;
      return { detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
        evidence: { sourceKey: "selected-posts", dataSourceId: "fictional-posts", databaseParentId: null, courseId: null, parentId: null, ordinal } };
    });
    const sources = [{ key: "selected-posts", kind: "post", mode: "allowlist", dataSourceId: "fictional-posts", databaseParentId: null, pageId: null }];
    const permits = batch.map(r => ({ id: r.detail.item.id, kind: "post", sourceKey: "selected-posts", courseId: null, parentId: null }));
    const digest = configDigest([sources, permits]);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const writer = publicationWriter(db, "published"), lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, batch); await writer.promote(lease, { records: 2, media: 0, complete: true });
    const publisher = createIncrementalPublisher(db);
    const prepared = () => publisher.state();
    await db.query("SELECT nb_v2_api.set_denied($1,true)", [batch[0].detail.item.id]);
    const deniedState = await prepared();
    await publisher.publish(randomUUID(), preparePublicationDelta({ expectedRevision: deniedState.publicationRevision,
      configDigest: digest, upserts: [batch[1]], media: [], withdrawals: [] }));
    const independent = createWebsiteDatabaseRepository(publicationReader(db, "published"));
    assert.equal((await independent.list("post")).total, 1);
    await db.query("SELECT nb_v2_api.set_denied($1,false)", [batch[0].detail.item.id]);
    assert.equal((await independent.list("post")).total, 2);
    const state = await prepared(), qualifiedBefore = (await db.query("SELECT valid_until FROM nb_v2.runs WHERE id=$1", [lease.runId])).rows[0];
    const delta = preparePublicationDelta({ expectedRevision: state.publicationRevision, configDigest: digest, upserts: [], media: [],
      withdrawals: [{ id: batch[0].detail.item.id, sourceKey: "selected-posts", reason: "archived" }] });
    await publisher.publish(randomUUID(), delta);
    const fresh = await prepared();
    await publisher.publish(randomUUID(), preparePublicationDelta({ expectedRevision: fresh.publicationRevision, configDigest: digest, upserts: [batch[1]], media: [], withdrawals: [] }));
    assert.equal((await createWebsiteDatabaseRepository(publicationReader(db, "published")).list("post")).total, 1);
    assert.equal((await createWebsiteDatabaseRepository(db).list("post")).total, 2);
    assert.deepEqual((await db.query("SELECT valid_until FROM nb_v2.runs WHERE id=$1", [lease.runId])).rows[0], qualifiedBefore);
    assert.equal((await db.query<{n: number}>("SELECT count(*)::int AS n FROM nb_v2.tombstones t JOIN nb_publication.state s ON t.run_id=s.run_id")).rows[0].n, 1);
  } finally { await db.close(); }
});
