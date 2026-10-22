import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, chmod, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureItems } from "../fixtures/content.ts";
import type { ContentDetail, StatusEntry } from "../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { PublicContentSnapshot } from "../contracts/website.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { exportPublicationHandoff } from "../scripts/website-sync/publication-handoff.ts";
import { planThumbnailCoverage } from "../scripts/media-thumbnails/planning.ts";

const runId = "00000000-0000-4000-8000-000000000001";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const releaseCommit = "a".repeat(40), sourceSha256 = "b".repeat(64);
async function fixture(t: TestContext) {
  const output = await realpath(await mkdtemp(join(tmpdir(), "publication-handoff-")));
  await chmod(output, 0o700); t.after(() => rm(output, { recursive: true, force: true }));
  const item = { ...structuredClone(fixtureItems.status[0]), id: "00000000-0000-4000-8000-000000000002", cover: null, text: [] };
  const detail: ContentDetail<StatusEntry> = { item, document: { blocks: [], toc: [], completeness: "complete" } };
  const projection = { runId, revision: "17", schemaDigest: WEBSITE_SCHEMA_DIGEST,
    records: [detail], links: [item.href], mediaIds: [] };
  const queries: { text: string; values?: unknown[] }[] = [];
  const db: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
    queries.push({ text, values }); return { rows: [{ result: projection } as T] };
  } };
  return { output, projection, queries, input: { db, output, runId, releaseCommit, sourceSha256, guard() {} } };
}

test("publication handoff feeds the existing planner and commits owner-only files with exact snapshot identity", async t => {
  const f = await fixture(t), reference = await exportPublicationHandoff(f.input);
  const text = await readFile(join(f.output, reference.snapshot), "utf8"), snapshot = JSON.parse(text) as PublicContentSnapshot;
  const manifest = JSON.parse(await readFile(join(f.output, reference.manifest), "utf8"));
  assert.equal(reference.snapshotSha256, hash(text));
  assert.equal(manifest.snapshot.sha256, hash(text));
  assert.equal(manifest.snapshot.bytes, Buffer.byteLength(text));
  assert.equal(manifest.snapshot.version, snapshot.version);
  assert.equal(manifest.runId, runId); assert.equal(manifest.validUntil, null);
  assert.equal(manifest.qualification, "RECHECK_CURRENT_RUN_AND_SOURCES_BEFORE_EXECUTION");
  assert.equal((await stat(join(f.output, "thumbnail-handoff"))).mode & 0o777, 0o700);
  for (const path of [reference.snapshot, reference.manifest]) assert.equal((await stat(join(f.output, path))).mode & 0o777, 0o600);
  assert.equal(f.queries.length, 1); assert.equal(f.queries[0].values?.[1], true);
  assert.deepEqual(f.queries[0].values?.[0], ["status", "album", "book", "movie", "game", "post", "project", "course"]);
  const now = Date.now();
  const plan = await planThumbnailCoverage({ snapshot, enabledKinds: ["status"], inventory: {
    format: "notionblog-thumbnail-inventory-v1", version: "v2", runId, snapshotVersion: snapshot.version,
    qualifiedAt: new Date(now).toISOString(), validUntil: new Date(now + 7200000).toISOString(), cells: [],
  }, limits: { maxParents: 1, maxOriginalBytes: 1024, maxUploadRequests: 1, maxUploadBodyBytes: 1024,
    maxDurationSeconds: 1, maxTotalParents: 1, maxTotalOriginalBytes: 1024, maxTotalUploadBodyBytes: 1024,
    maxTotalDurationSeconds: 1, eligibilityReserveSeconds: 3600 } }, now);
  assert.equal(plan.status, "PLANNING_ONLY"); assert.equal(plan.summary.recordCount, 1);
});

test("handoff uses current website withdrawal projection instead of persisting stale staged references", async t => {
  const f = await fixture(t);
  f.projection.records[0].document!.blocks = [
    { id: "withdrawn-image", type: "image", image: { id: "dead", src: "/media/v2/dead", alt: "Private", width: 1, height: 1 }, caption: [] },
    { id: "withdrawn-link", type: "paragraph", text: [{ text: "Withdrawn title", link: { kind: "internal", href: "/blog/withdrawn" } }] },
  ];
  const reference = await exportPublicationHandoff(f.input), text = await readFile(join(f.output, reference.snapshot), "utf8");
  assert.equal(text.includes("/media/v2/dead"), false); assert.equal(text.includes("/blog/withdrawn"), false);
  assert.equal(text.includes("Withdrawn title"), false); assert.ok(text.includes("Image unavailable"));
});

test("changed run, incompatible schema and expired reader errors never produce a handoff", async t => {
  for (const kind of ["run", "schema", "expired"]) {
    const f = await fixture(t);
    if (kind === "run") f.projection.runId = "00000000-0000-4000-8000-000000000003";
    if (kind === "schema") f.projection.schemaDigest = "c".repeat(64);
    if (kind === "expired") f.input.db = { query: async () => { throw new Error("NB_CONTENT_UNAVAILABLE"); } };
    await assert.rejects(exportPublicationHandoff(f.input)); assert.deepEqual(await readdir(f.output), []);
  }
});

test("cancelled export has no commit marker; completed bundles cannot be overwritten", async t => {
  const f = await fixture(t); let calls = 0;
  f.input.guard = () => { if (++calls === 3) throw new Error("Cancelled"); };
  await assert.rejects(exportPublicationHandoff(f.input));
  assert.deepEqual(await readdir(join(f.output, "thumbnail-handoff")), ["snapshot-private.json"]);
  const good = await fixture(t), first = await exportPublicationHandoff(good.input);
  const text = await readFile(join(good.output, first.manifest), "utf8");
  good.projection.revision = "18";
  await assert.rejects(exportPublicationHandoff(good.input));
  assert.equal(await readFile(join(good.output, first.manifest), "utf8"), text);
});
