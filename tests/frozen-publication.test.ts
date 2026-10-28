import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createIncrementalPublisher, preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { createFreezeStore } from "../src/server/database/freeze.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installFreeze } from "../scripts/website-sync/freeze-migration.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

test("frozen publication is inactive on install, preserves exact versions and refreshes atomically", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    const owner: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      if (sql.startsWith("-- Opt-in")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await installPublication(owner); await installIncrementalPublication(owner);
    await installFreeze(owner); await installFreeze(owner);
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const source = [{ key: "posts", kind: "post", mode: "all", dataSourceId: "source-posts", databaseParentId: null, pageId: null }];
    const digest = "a".repeat(64);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(source)]);
    const records: WebsiteRecord[] = fixtureItems.post.slice(0, 2).map((original, ordinal) => {
      const item = structuredClone(original); item.cover = null;
      return { detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
        evidence: { sourceKey: "posts", dataSourceId: "source-posts", databaseParentId: null, courseId: null, parentId: null, ordinal } };
    });
    const writer = publicationWriter(role("nb_writer"), "published");
    const lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, records); await writer.promote(lease, { records: records.length, media: 0, complete: true });
    const frozen = createFreezeStore(role("nb_freeze_operator"));
    const publisher = createIncrementalPublisher(role("nb_writer"));
    const refresh = createFreezeStore(role("nb_writer"));
    const repo = createWebsiteDatabaseRepository(publicationReader(role("nb_reader"), "published"));
    const page = records[0].detail.item;
    const prepare = async (index: number, title: string) => {
      const changed = structuredClone(records[index]); changed.detail.item.title = title;
      return preparePublicationDelta({ expectedRevision: (await publisher.state()).publicationRevision, configDigest: digest, upserts: [changed], media: [], withdrawals: [] });
    };
    await t.test("installation neither activates freezing nor grants private/API-role access", async () => {
      assert.equal((await frozen.state()).enabled, false);
      await assert.rejects(frozen.preview(page.id, "freeze"), /FREEZE_DISABLED/);
      for (const name of ["nb_reader", "nb_writer", "nb_freeze_operator", "anon", "authenticated", "service_role"]) {
        await assert.rejects(role(name).query("SELECT * FROM nb_freeze.members"));
      }
      await assert.rejects(role("nb_writer").query("SELECT nb_freeze_api.freeze($1,$2,$3,'[]')", [randomUUID(), page.id, digest]));
    });
    await db.query("UPDATE nb_freeze.state SET enabled=true");
    let groupId: string;
    await t.test("preview fences publication changes and idempotency does not reapply an operation", async () => {
      const stale = await frozen.preview(page.href, "freeze");
      await publisher.publish(randomUUID(), await prepare(1, "Unrelated revision"));
      await assert.rejects(frozen.freeze(randomUUID(), stale, []), /FREEZE_PREVIEW_STALE/);
      const plan = await frozen.preview(page.id, "freeze");
      const op = randomUUID(), result = await frozen.freeze(op, plan, []); groupId = result.groupId;
      assert.equal(result.pages, 1); assert.deepEqual(await frozen.freeze(op, plan, []), result);
      assert.deepEqual(await frozen.lookup(op), result);
      await assert.rejects(frozen.freeze(op, { ...plan, digest: "b".repeat(64) }, []), /FREEZE_OPERATION_CONFLICT/);
      await assert.rejects(frozen.preview(page.id, "freeze"), /FREEZE_ALREADY_FROZEN/);
    });
    await t.test("old writers cannot overwrite or withdraw a frozen version; other pages still update", async () => {
      await assert.rejects(publisher.publish(randomUUID(), await prepare(0, "Must not replace")), /FREEZE_PROTECTED/);
      const delta = preparePublicationDelta({ expectedRevision: (await publisher.state()).publicationRevision, configDigest: digest,
        upserts: [], media: [], withdrawals: [{ id: page.id, sourceKey: "posts", reason: "deleted" }] });
      await assert.rejects(publisher.publish(randomUUID(), delta), /FREEZE_PROTECTED/);
      await publisher.publish(randomUUID(), await prepare(1, "Other page updated"));
      assert.equal((await repo.get("post", page.slug))?.item.title, page.title);
    });
    await t.test("a failed refresh rolls back both content and its protection; successful refresh remains frozen", async () => {
      const state = await frozen.state(), delta = await prepare(0, "New frozen revision");
      await assert.rejects(refresh.refresh(randomUUID(), groupId!, "999", delta), /FREEZE_PREVIEW_STALE/);
      const broken = structuredClone(delta); broken.configDigest = "b".repeat(64);
      await assert.rejects(refresh.refresh(randomUUID(), groupId!, state.generation, broken));
      assert.equal((await frozen.state()).members[0].id, page.id);
      assert.equal((await repo.get("post", page.slug))?.item.title, page.title);
      const operation = randomUUID(), receipt = await refresh.refresh(operation, groupId!, state.generation, delta);
      assert.equal(receipt.committed, true);
      assert.equal((await repo.get("post", page.slug))?.item.title, "New frozen revision");
      assert.equal((await frozen.state()).members[0].groupId, groupId!);
      assert.deepEqual(await refresh.refresh(operation, groupId!, state.generation, delta), receipt);
    });
    await t.test("central deny remains stronger than freezing, and permanent unfreeze permits normal updates", async () => {
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [page.id]);
      assert.equal(await repo.get("post", page.slug), null);
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [page.id]);
      assert.equal((await repo.get("post", page.slug))?.item.title, "New frozen revision");
      const plan = await frozen.preview(page.id, "permanent"), op = randomUUID();
      const result = await frozen.unfreeze(op, plan);
      assert.deepEqual(result.members, [{ id: page.id, sourceKey: "posts" }]);
      assert.deepEqual(await frozen.unfreeze(op, plan), result);
      assert.equal((await frozen.state()).members.length, 0);
      await publisher.publish(randomUUID(), await prepare(0, "Normally updated"));
      assert.equal((await repo.get("post", page.slug))?.item.title, "Normally updated");
    });
  } finally { await db.close(); }
});
