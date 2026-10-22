import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { createDemo, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle } from "../scripts/website-incremental-sync/executor.ts";
import { createSinglePagePreparationPort } from "../scripts/website-incremental-sync/source.ts";
import { createDatabasePublicationPort, createDatabasePublishedPageReader } from "../scripts/website-incremental-sync/publication-port.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import { preparePublicationDelta, readPublicationState } from "../src/server/database/incremental-publication.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

test("queue, one-page converter and actual delta SQL update one page while preserving the other published bodies", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "incremental-sql-integration-")));
  const db = await PGlite.create();
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; }
    return db.query<T>(sql, values);
  } };
  await installPublication(operator); await installIncrementalPublication(operator); await installIncrementalReader(operator);
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const writer = role("nb_writer"), reader = role("nb_reader"), demo = createDemo(3), owner = demoId(1000);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0] }] });
  const bodyReads: string[] = [];
  const client: NotionReadClient = {
    getPage: async id => structuredClone(demo.pages.get(id) ?? null),
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(b => b.id === id) ?? null),
    listBlocks: async id => { bodyReads.push(id); return structuredClone(demo.blocks.get(id) ?? []); },
    listPages: async id => structuredClone([...demo.pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === id)),
  };
  const policy = await websitePolicy(client, config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [policy.configDigest, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  await runWebsiteSync({ client, config, mode: "publish", writer: publicationWriter(writer, "published"),
    storage: { read: async () => new Uint8Array(), put: async () => { assert.fail("No fixture image should be uploaded"); } },
  });
  const repository = createWebsiteDatabaseRepository(publicationReader(reader, "published"));
  const untouched = await repository.get("status", demoId(1001));
  demo.blocks.set(owner, [demoParagraph(demoId(57100), owner, "Updated by one-page delta")]);
  bodyReads.length = 0;
  client.listPages = async () => { assert.fail("Incremental preparation must not enumerate source rows"); };
  const queue = await openIncrementalQueue(directory, { digest: policy.configDigest, sourceKeys: ["status"] });
  t.after(() => queue.close());
  queue.enqueue([{ eventId: "changed", sourceKey: "status", pageKey: owner, reason: "content", observedAt: 1000 }]);
  const publication = createDatabasePublicationPort(writer, reader);
  let verified = 0;
  const verify = publication.verify;
  publication.verify = async (receipt, signal) => { verified++; return verify(receipt, signal); };
  const prepare = createSinglePagePreparationPort({ client, config, placement: async () => ({ ordinal: 0 }),
    readPublished: createDatabasePublishedPageReader(reader), prepareDelta: preparePublicationDelta,
    prepareImage: async () => { assert.fail("No fixture image requires a media operation"); },
  });
  const result = await runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, maxTasks: 1 }, { ...publication, prepare });
  assert.equal(result.outcome, "updated"); assert.equal(result.published, 1); assert.equal(verified, 1);
  assert.deepEqual(bodyReads, [owner]); assert.equal(queue.status().done, 1);
  assert.deepEqual(await repository.get("status", demoId(1001)), untouched);
  assert.equal((await repository.list("status", { limit: 10 })).total, 3);
  const current = await readPublicationState(reader);
  const proof = await createDatabasePublishedPageReader(reader)({ operationId: "unused", sourceKey: "status", pageKey: owner, generation: 1, reasons: [] }, current, new AbortController().signal);
  assert.ok(proof && JSON.stringify(proof.record.detail.document).includes("Updated by one-page delta"));
  bodyReads.length = 0;
  queue.enqueue([{ eventId: "duplicate-edit-signal", sourceKey: "status", pageKey: owner, reason: "content", observedAt: 1001 }]);
  const next = await runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, maxTasks: 1 }, { ...publication, prepare });
  assert.equal(next.outcome, "unchanged"); assert.equal(next.published, 0); assert.equal(verified, 1);
  assert.deepEqual(bodyReads, [owner]);
  demo.pages.get(owner)!.archived = true; bodyReads.length = 0;
  queue.enqueue([{ eventId: "source-archived", sourceKey: "status", pageKey: owner, reason: "reconcile", observedAt: 1002 }]);
  const withdrawn = await runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, maxTasks: 1 }, { ...publication, prepare });
  assert.equal(withdrawn.outcome, "updated"); assert.equal(withdrawn.published, 1); assert.equal(verified, 2);
  assert.deepEqual(bodyReads, []); assert.equal(await repository.get("status", owner), null);
  assert.equal((await repository.list("status", { limit: 10 })).total, 2);
  assert.deepEqual(await repository.get("status", demoId(1001)), untouched);
});
