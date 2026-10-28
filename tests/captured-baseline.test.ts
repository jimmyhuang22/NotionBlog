import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { hostFixture } from "./helpers/incremental-host.ts";
import { createCollectionCapture } from "../scripts/website-sync/collection-capture.ts";
import { createCollectionReadSession } from "../scripts/website-sync/collection-source-proof.ts";
import { prepareCapturedBaseline } from "../scripts/website-incremental-sync/captured-baseline.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { parseIncrementalArguments } from "../scripts/website-incremental-sync/cli.ts";
import { validateStudyBaselineCollection } from "../scripts/website-incremental-sync/study-baseline.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { DEMO } from "../scripts/notion-sync/demo.ts";

test("existing capture becomes an independently verified baseline without a second content collection", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const identity = {runId: f.artifact.fullRunId, sourceSha256: "a".repeat(64), releaseCommit: "b".repeat(40), configDigest: f.digest};
  const directory = join(f.root, "capture"), capture = await createCollectionCapture(directory, identity);
  const reads = createCollectionReadSession(f.demo.client, () => {});
  for (const record of f.artifact.collection.records) {
    const trace = reads.trace(); await trace.client.getPage(record.detail.item.id);
    await capture.save({record, media: [], bindings: [], lease: null, sourceReads: trace.seal()});
  }
  const requested: string[] = [], client = {getPage: async (id: string) => {requested.push(id); return f.demo.client.getPage(id);}};
  await assert.rejects(prepareCapturedBaseline({directory, identity, config: f.config, deniedPageIds: [], client}, new AbortController().signal), /CAPTURE_BASELINE_INCOMPLETE/);
  assert.equal(requested.length, 0);
  await capture.seal(f.artifact.collection.records.map(r => r.detail.item.id));
  const prepared = await prepareCapturedBaseline({directory, identity, config: f.config, deniedPageIds: [], client}, new AbortController().signal);
  assert.deepEqual(prepared.collection.records, f.artifact.collection.records);
  assert.deepEqual(requested.sort(), [DEMO.course, DEMO.week].sort());
  assert.ok(prepared.directory.skipped > 0); // Unknown directory fingerprints are discovered normally.
  const artifactPath = join(f.root, "accepted.json");
  await writeFile(artifactPath, JSON.stringify({format: "incremental-baseline-v1", fullRunId: prepared.fullRunId,
    state: f.state, collection: prepared.collection, media: prepared.media, deniedPageIds: [], directory: prepared.directory}), {mode: 0o600});
  const tooSmall = await runIncrementalHost({...f.options, artifactPath, maxBaselineReads: 1}, f.deps);
  assert.equal(tooSmall.outcome, "failed"); assert.equal(tooSmall.errorCode, "CONTENT_BASELINE_BUDGET_EXCEEDED");
  const result = await runIncrementalHost({...f.options, artifactPath, maxBaselineReads: 3000}, f.deps);
  assert.equal(result.outcome, "initialized", JSON.stringify(result));
  assert.equal(f.counts.factories, 0); assert.equal(f.counts.sourceCalls, 0);
  f.demo.pages.get(DEMO.course)!.last_edited_time = "2026-10-28T00:00:00.000Z";
  await assert.rejects(prepareCapturedBaseline({directory, identity, config: f.config, deniedPageIds: [], client}, new AbortController().signal), /CAPTURE_BASELINE_ORDERING_CHANGED/);
});

test("bootstrap read allowance is explicit and cannot enlarge a normal sync", () => {
  const paths = ["--config", "/private/source.json", "--runtime-dir", "/private/runtime", "--lock-dir", "/private/canonical"];
  assert.equal(parseIncrementalArguments(["initialize", ...paths, "--artifact", "/private/accepted.json", "--baseline-reads", "3000"]).maxBaselineReads, 3000);
  assert.throws(() => parseIncrementalArguments(["run", ...paths, "--baseline-reads", "3000"]), /HOST_INPUT_INVALID/);
});

test("a complete learning baseline above 16 MiB retains its bodies and ordering", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const course = structuredClone(f.artifact.collection.records.find(r => r.detail.item.kind === "course")!);
  const template = f.artifact.collection.records.find(r => r.detail.item.kind === "study-note")!;
  const notes = Array.from({length: 128}, (_, ordinal) => {
    const r = structuredClone(template), id = (1000 + ordinal).toString(16).padStart(32, "0");
    r.detail.item.id = id; r.detail.item.title = `Note ${String(ordinal).padStart(3, "0")}`;
    r.detail.item.slug = id; r.detail.item.href = `${course.detail.item.href}/notes/${id}`; r.evidence.ordinal = ordinal;
    r.detail.document = {blocks: [{id: "paragraph", type: "paragraph", text: [{text: "x".repeat(135000)}]}], toc: [], completeness: "complete"};
    return r;
  });
  const records = [course, ...notes], entries = records.map(record => ({record, override: null, position: record.detail.item.kind === "course" ? null : record.evidence.ordinal}));
  const collection = {records, baseline: {format: "study-baseline-v1" as const, sourceDigest: f.digest, recordsDigest: configDigest(records),
    entriesDigest: configDigest(entries), deniedDigest: configDigest([]), sourceKeys: f.config.sources.filter(s => ["course", "study-note"].includes(s.kind)).map(s => s.key).sort(), entries}};
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) > 16 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(collection)) > 32 * 1024 * 1024);
  assert.doesNotThrow(() => validateStudyBaselineCollection(collection, f.config, new Set()));
});
