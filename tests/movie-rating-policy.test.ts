import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PageObjectResponse, DataSourceObjectResponse } from "@notionhq/client";
import type { Movie } from "../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { movieRatingFact } from "../src/lib/library.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { movieRatingMappingAddition, applyMovieRatingMappingPolicy, rollbackMovieRatingMappingPolicy,
  type MovieRatingPolicyOwner } from "../scripts/website-sync/movie-rating-policy.ts";
import publicationProtocol from "../database/publication-protocol.json" with { type: "json" };

const id = (n: number) => n.toString(16).padStart(32, "0");
const rich = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, href: null,
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
const controlled = (code = "MISCONFIGURED") => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;

function configuration() {
  const previous = { schemaVersion: 2, timeZone: "UTC", sources: [
    { key: "fictional-movies", kind: "movie", enabled: true, dataSourceId: id(1),
      fields: { title: "Name", doubanRating: "Score", rating: "Personal", status: "Status" } as Record<string, string>,
      statusMap: { Watched: "watched" }, publication: { mode: "allowlist", allowlistPageIds: [id(2), id(3), id(4)] },
      localComment: "preserve raw unparsed values" },
    { key: "disabled", kind: "movie", enabled: false, dataSourceId: id(9), fields: { title: "Other" } as Record<string, string>,
      statusMap: {}, publication: { mode: "all", allowlistPageIds: [] as string[] }, localComment: "unchanged" },
  ] };
  const current = structuredClone(previous);
  Object.assign(current.sources[0].fields, { publicRating: "Score", ratingSource: "Source" });
  const previousText = JSON.stringify(previous), currentText = JSON.stringify(current);
  return { previous, current, previousText, currentText,
    transition: movieRatingMappingAddition(previousText, currentText, "fictional-movies") };
}

test("movie mapping addition binds exact raw inputs and rejects all scope or unrelated configuration edits", () => {
  const f = configuration();
  assert.equal(f.transition.previousSourceSha256, createHash("sha256").update(f.previousText).digest("hex"));
  assert.equal(f.transition.currentSourceSha256, createHash("sha256").update(f.currentText).digest("hex"));
  assert.notEqual(f.transition.previousConfigDigest, f.transition.currentConfigDigest);
  assert.ok(Object.isFrozen(f.transition));
  // Formatting/key order are not configuration changes, but their raw binding differs.
  assert.equal(movieRatingMappingAddition(f.previousText, JSON.stringify(f.current, null, 2), "fictional-movies").currentConfigDigest, f.transition.currentConfigDigest);
  for (const mutate of [
    (x: typeof f.current) => { delete x.sources[0].fields.ratingSource; },
    (x: typeof f.current) => { delete x.sources[0].fields.publicRating; },
    (x: typeof f.current) => { x.sources[0].fields.publicRating = "Other score"; },
    (x: typeof f.current) => { x.sources[0].fields.ratingSource = "Score"; },
    (x: typeof f.current) => { x.sources[0].fields.ratingSource = " "; },
    (x: typeof f.current) => { x.sources[0].fields.rating = "Other personal"; },
    (x: typeof f.current) => { x.sources[0].fields.doubanRating = "Other legacy"; },
    (x: typeof f.current) => { x.timeZone = "Europe/London"; },
    (x: typeof f.current) => { x.sources[0].dataSourceId = id(8); },
    (x: typeof f.current) => { x.sources[0].publication.allowlistPageIds.push(id(8)); },
    (x: typeof f.current) => { x.sources[0].enabled = false; },
    (x: typeof f.current) => { x.sources[0].localComment = "changed"; },
    (x: typeof f.current) => { x.sources[1].fields.title = "changed disabled source"; },
    (x: typeof f.current) => { x.sources.reverse(); },
    (x: typeof f.current) => { x.sources.push(structuredClone(x.sources[1])); },
  ]) {
    const changed = structuredClone(f.current); mutate(changed);
    assert.throws(() => movieRatingMappingAddition(f.previousText, JSON.stringify(changed), "fictional-movies"), controlled());
  }
  for (const key of ["missing", "disabled"]) assert.throws(() => movieRatingMappingAddition(f.previousText, f.currentText, key), controlled());
  assert.throws(() => movieRatingMappingAddition(f.currentText, f.currentText, "fictional-movies"), controlled());
  assert.throws(() => movieRatingMappingAddition(f.previousText, f.previousText, "fictional-movies"), controlled());
  assert.throws(() => movieRatingMappingAddition("not json", f.currentText, "fictional-movies"), controlled());
  const missingLegacy = structuredClone(f.previous); delete missingLegacy.sources[0].fields.doubanRating;
  assert.throws(() => movieRatingMappingAddition(JSON.stringify(missingLegacy), f.currentText, "fictional-movies"), controlled());
  for (const key of ["publicRating", "ratingSource"]) {
    const partlyMapped = structuredClone(f.previous); partlyMapped.sources[0].fields[key] = f.current.sources[0].fields[key];
    assert.throws(() => movieRatingMappingAddition(JSON.stringify(partlyMapped), f.currentText, "fictional-movies"), controlled());
  }
});

async function fixture(t: test.TestContext) {
  const f = configuration(), db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const pages = [8.2, 0, null].map((score, index) => ({ object: "page", id: id(index + 2),
    parent: { type: "data_source_id", data_source_id: id(1) }, archived: false, in_trash: false, cover: null,
    last_edited_time: "2026-10-10T12:00:00Z", properties: {
      Name: { id: "title", type: "title", title: [rich(`Fictional film ${index}`)] },
      Score: { id: "score", type: "number", number: score }, Personal: { id: "personal", type: "number", number: 4 },
      Status: { id: "status", type: "select", select: { name: "Watched" } },
      Source: { id: "source", type: "rich_text", rich_text: [rich("Bangumi")] },
    } })) as unknown as PageObjectResponse[];
  let bodyReads = 0;
  const client: NotionReadClient = {
    getPage: async key => structuredClone(pages.find(page => page.id === key) ?? null),
    getDataSource: async () => ({ id: id(1), properties: Object.fromEntries(Object.entries(pages[0].properties).map(([name, p]) => [name, { id: p.id, type: p.type }])) }) as DataSourceObjectResponse,
    getBlock: async () => null, listBlocks: async () => { bodyReads++; return []; }, listPages: async () => structuredClone(pages),
  };
  const before = parseWebsiteNotionConfig(f.previous), after = parseWebsiteNotionConfig(f.current);
  const previousPolicy = await websitePolicy(client, before, 600), nextPolicy = await websitePolicy(client, after, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",
    [previousPolicy.configDigest, JSON.stringify(previousPolicy.sources), JSON.stringify(previousPolicy.permits)]);
  const role = (name: "nb_writer" | "nb_reader"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const writer = createWebsiteWriter(role("nb_writer")), reader = createWebsiteDatabaseRepository(role("nb_reader"));
  const rows = await createWebsiteNotionRepository({ client, config: before }).collectRecords();
  for (const row of rows) { delete (row.detail.item as Movie).publicRating; delete (row.detail.item as Movie).ratingSource; }
  const oldLease = await writer.begin(randomUUID(), previousPolicy.configDigest);
  await writer.stage(oldLease, rows); await writer.promote(oldLease, { records: rows.length, media: 0, complete: true });
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [id(99)]);
  const state = async () => (await db.query<{ revision: string; epoch: string; currentRun: string | null }>(
    "SELECT revision::text,epoch::text,current_run::text AS \"currentRun\" FROM nb_v2.state")).rows[0];
  const snapshot = async () => (await db.query<{ value: Record<string, unknown> }>("SELECT to_jsonb(s) AS value FROM nb_v2.state s")).rows;
  const preserved = async () => (await db.query(`SELECT jsonb_build_object(
    'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM nb_v2.runs r),
    'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM nb_v2.sources s),
    'permits',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM nb_v2.permits p),
    'records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY run_id,id) FROM nb_v2.records r),
    'denied',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM nb_v2.denied d)) AS value`)).rows;
  return { ...f, db, pages, client, before, after, previousPolicy, nextPolicy, writer, reader, oldLease,
    state, snapshot, preserved, bodyReads: () => bodyReads };
}

test("owner transition preserves the legacy success and a full ordinary collection publishes current movie scores", async t => {
  const f = await fixture(t), state = await f.state(), preserved = await f.preserved(), beforeState = (await f.snapshot())[0].value;
  const result = await applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, state);
  assert.equal(result.revision, String(BigInt(state.revision) + 1n));
  assert.equal(result.epoch, state.epoch); assert.equal(result.currentRun, f.oldLease.runId);
  assert.equal(result.requiresFullCollection, true);
  assert.deepEqual((await f.snapshot())[0].value, { ...beforeState, config_digest: f.nextPolicy.configDigest, revision: Number(result.revision) });
  assert.deepEqual(await f.preserved(), preserved);
  const legacy = (await f.reader.list("movie", { limit: 50 })).items;
  assert.equal(legacy.length, 3); assert.equal(legacy.find(x => x.id === id(2))!.ratingSource, undefined);
  assert.deepEqual(movieRatingFact(legacy.find(x => x.id === id(2))!), ["公共评分", "8.2"]);
  await assert.rejects(f.writer.begin(randomUUID(), f.previousPolicy.configDigest), controlled("CONTENT_UNAVAILABLE"));
  const beforeBodies = f.bodyReads();
  await runWebsiteSync({ client: f.client, config: f.after, writer: f.writer, mode: "publish",
    storage: { put: async () => assert.fail("No images"), read: async () => new Uint8Array() } });
  assert.equal(f.bodyReads() - beforeBodies, 3); // All pages collected; no resume input.
  const movies = (await f.reader.list("movie", { limit: 50 })).items;
  assert.deepEqual(movieRatingFact(movies.find(x => x.id === id(2))!), ["Bangumi 评分", "8.2"]);
  assert.deepEqual(movieRatingFact(movies.find(x => x.id === id(3))!), ["Bangumi 评分", "0"]);
  const empty = movies.find(x => x.id === id(4))!;
  assert.equal(empty.publicRating, null); assert.equal(empty.ratingSource, null); assert.equal(movieRatingFact(empty), null);
  assert.ok(movies.every(x => x.rating?.value === 4));
  await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [id(2)]);
  assert.equal(await f.reader.get("movie", id(2)), null);
});

test("exact rollback advances revision without altering runs or reviving the old writer", async t => {
  const f = await fixture(t), preserved = await f.preserved(), initial = await f.state();
  await applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, initial);
  const applied = await f.state();
  const back = await rollbackMovieRatingMappingPolicy(f.db, f.transition, f.previousPolicy, applied);
  assert.equal(back.configDigest, f.transition.previousConfigDigest);
  assert.equal(back.revision, String(BigInt(initial.revision) + 2n));
  assert.equal(back.epoch, initial.epoch); assert.equal(back.currentRun, initial.currentRun);
  assert.deepEqual(await f.preserved(), preserved);
  assert.equal((await f.reader.list("movie")).total, 3);
  await assert.rejects(f.writer.stage(f.oldLease, []), controlled("CONTENT_UNAVAILABLE"));
  await assert.rejects(rollbackMovieRatingMappingPolicy(f.db, f.transition, f.previousPolicy, applied), controlled());
});

test("all state mismatches, occupied leases and installed policy drift block the owner update", async t => {
  const f = await fixture(t), initial = await f.state(), stable = await f.snapshot();
  for (const mutate of [
    (p: typeof f.nextPolicy) => { p.configDigest = f.previousPolicy.configDigest; },
    (p: typeof f.nextPolicy) => { p.sources[0].dataSourceId = id(8); },
    (p: typeof f.nextPolicy) => { p.permits = []; },
    (p: typeof f.nextPolicy) => { p.freshnessSeconds = 86401; },
  ]) {
    const policy = structuredClone(f.nextPolicy); mutate(policy);
    await assert.rejects(applyMovieRatingMappingPolicy(f.db, f.transition, policy, initial), controlled());
    assert.deepEqual(await f.snapshot(), stable);
  }
  for (const expected of [ { ...initial, revision: "0" }, { ...initial, epoch: "0" }, { ...initial, currentRun: null } ]) {
    await assert.rejects(applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, expected), controlled());
    assert.deepEqual(await f.snapshot(), stable);
  }
  for (const edit of [
    "UPDATE nb_v2.state SET config_digest='different'",
    "UPDATE nb_v2.state SET freshness_seconds=601",
    "UPDATE nb_v2.state SET lease_until=clock_timestamp() - interval '1 second'",
    "UPDATE nb_v2.sources SET mode='all'",
    "DELETE FROM nb_v2.permits",
  ]) {
    await assert.rejects(f.db.transaction(async tx => {
      await tx.exec(edit);
      await applyMovieRatingMappingPolicy({ transaction: work => work(tx) }, f.transition, f.nextPolicy, initial);
    }), controlled());
    assert.deepEqual(await f.snapshot(), stable);
  }
  const active = await f.writer.begin(randomUUID(), f.previousPolicy.configDigest);
  const occupied = await f.snapshot();
  await assert.rejects(applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, await f.state()), controlled());
  assert.deepEqual(await f.snapshot(), occupied);
  await f.writer.fail(active);
});

test("transaction failure after the UPDATE rolls back every policy change and hides driver values", async t => {
  const f = await fixture(t), stable = await f.snapshot(), preserved = await f.preserved();
  const owner: MovieRatingPolicyOwner = { transaction: work => f.db.transaction(async tx => {
    await work(tx); throw new Error("private driver value must not escape");
  }) };
  await assert.rejects(applyMovieRatingMappingPolicy(owner, f.transition, f.nextPolicy, await f.state()),
    error => controlled("CONTENT_UNAVAILABLE")(error) && !String(error).includes("private driver value"));
  assert.deepEqual(await f.snapshot(), stable); assert.deepEqual(await f.preserved(), preserved);
});

test("autocommit adapters, copied review objects and writer/reader roles cannot update the policy", async t => {
  const f = await fixture(t), initial = await f.state(), stable = await f.snapshot();
  await assert.rejects(applyMovieRatingMappingPolicy({ transaction: work => work(f.db) }, f.transition, f.nextPolicy, initial), controlled());
  for (const transition of [ { ...f.transition }, JSON.parse(JSON.stringify(f.transition)) ]) {
    await assert.rejects(applyMovieRatingMappingPolicy(f.db, transition, f.nextPolicy, initial), controlled());
  }
  for (const name of ["nb_writer", "nb_reader"] as const) {
    const owner: MovieRatingPolicyOwner = { transaction: work => f.db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return work(tx);
    }) };
    await assert.rejects(applyMovieRatingMappingPolicy(owner, f.transition, f.nextPolicy, initial), controlled("CONTENT_UNAVAILABLE"));
  }
  assert.deepEqual(await f.snapshot(), stable);
});

test("caller mutations after transaction entry cannot replace the reviewed target or expected state", async t => {
  const f = await fixture(t), policy = structuredClone(f.nextPolicy), state = await f.state();
  const owner: MovieRatingPolicyOwner = { transaction: work => {
    policy.configDigest = "changed"; policy.sources.length = 0; state.epoch = "999";
    return f.db.transaction(work);
  } };
  const result = await applyMovieRatingMappingPolicy(owner, f.transition, policy, state);
  assert.equal(result.configDigest, f.transition.currentConfigDigest);
  assert.notEqual(result.epoch, "999");
});

async function installInactivePublication(db: PGlite) {
  await db.exec(await readFile(new URL(`../supabase/migrations/${publicationProtocol.migration.file}`, import.meta.url), "utf8"));
  await db.query("UPDATE nb_publication.state SET migration_digest=$1", [publicationProtocol.migration.sha256]);
}

test("an installed but inactive publication extension remains inactive through apply and rollback", async t => {
  const f = await fixture(t); await installInactivePublication(f.db);
  const pointer = (await f.db.query("SELECT to_jsonb(s) FROM nb_publication.state s")).rows;
  await applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, await f.state());
  await rollbackMovieRatingMappingPolicy(f.db, f.transition, f.previousPolicy, await f.state());
  assert.deepEqual((await f.db.query("SELECT to_jsonb(s) FROM nb_publication.state s")).rows, pointer);
  assert.equal((await f.reader.list("movie")).total, 3);
});

test("an adopted published snapshot blocks either direction rather than becoming unreadable", async t => {
  const f = await fixture(t); await installInactivePublication(f.db);
  await f.db.query("SELECT nb_publication_api.activate($1)", [f.oldLease.runId]);
  const published = async () => (await f.db.query("SELECT nb_publication_api.read_snapshot(ARRAY['movie'],true) AS result")).rows;
  const before = await published(), stable = await f.snapshot();
  await assert.rejects(applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, await f.state()), controlled());
  assert.deepEqual(await published(), before); assert.deepEqual(await f.snapshot(), stable);
  // Demonstrate the real extension's digest mismatch, then roll the test back.
  await assert.rejects(f.db.transaction(async tx => {
    await tx.query("UPDATE nb_v2.state SET config_digest=$1", [f.nextPolicy.configDigest]);
    await tx.query("SELECT nb_publication_api.read_snapshot(ARRAY['movie'],true)");
  }), /NB_UNAVAILABLE/);
  assert.deepEqual(await published(), before);
  // Rollback has the same boundary, including a newly adopted current batch.
  await f.db.exec("UPDATE nb_publication.state SET run_id=NULL,published_at=NULL");
  await applyMovieRatingMappingPolicy(f.db, f.transition, f.nextPolicy, await f.state());
  await runWebsiteSync({ client: f.client, config: f.after, writer: f.writer, mode: "publish",
    storage: { put: async () => assert.fail("No images"), read: async () => new Uint8Array() } });
  const next = await f.state();
  await f.db.query("SELECT nb_publication_api.activate($1)", [next.currentRun]);
  const current = await published(), installed = await f.snapshot();
  await assert.rejects(rollbackMovieRatingMappingPolicy(f.db, f.transition, f.previousPolicy, next), controlled());
  assert.deepEqual(await published(), current); assert.deepEqual(await f.snapshot(), installed);
});
