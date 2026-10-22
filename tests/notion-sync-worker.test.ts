import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse } from "@notionhq/client";
import { runSync } from "../scripts/notion-sync/worker.ts";
import { FakeWriter, FakeStorage } from "../scripts/notion-sync/fakes.ts";
import { createDemo, DEMO, demoId, demoParagraph, demoPage } from "../scripts/notion-sync/demo.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";

const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
const setup = (statuses = 2) => ({ ...createDemo(statuses), writer: new FakeWriter(), storage: new FakeStorage() });
const options = (s: ReturnType<typeof setup>) => ({ client: s.client, config: s.config, download: s.download, writer: s.writer, storage: s.storage, mode: "publish" as const });
const bodyReads = (s: ReturnType<typeof setup>) => s.requests.filter(r => r.category === "blocks");

test("full snapshot traverses source and block cursors, preserves all learning levels and stores bytes", async () => {
  const s = setup(125); let checkpoints = 0;
  const report = await runSync({ ...options(s), checkpoint: async () => { assert.equal(s.writer.calls.at(-1), "promote"); checkpoints++; } });
  assert.equal(report.records, 129); assert.equal(report.media, 1); assert.equal(report.uniqueObjects, 1);
  assert.equal(s.storage.puts, 1); assert.equal(s.writer.current.size, 129); assert.equal(checkpoints, 1);
  assert.equal(s.requests.filter(r => r.category === "rows" && r.id === DEMO.statuses).length, 2);
  assert.equal(bodyReads(s).filter(r => r.id === DEMO.week).length, 2);
  assert.equal(s.writer.current.get(DEMO.week)!.detail.document!.blocks.length, 110);
  assert.equal(s.writer.current.get(DEMO.week)!.evidence.parentId, DEMO.course);
  assert.equal(s.writer.current.get(DEMO.child)!.evidence.parentId, DEMO.week);
  assert.equal(s.writer.current.get(DEMO.grandchild)!.evidence.parentId, DEMO.child);
  const week = s.writer.current.get(DEMO.week)!.detail.item;
  assert.equal(week.kind === "study-note" && week.parentId, null);
  assert.equal(bodyReads(s).some(r => r.id === DEMO.private), false);
  assert.ok(s.requests.every(r => r.method === "GET" || (r.method === "POST" && r.category === "rows")));
  const status = s.writer.current.get(demoId(1000))!.detail.item;
  assert.equal(status.kind === "status" && status.recordedAt, null); assert.equal(status.cover, null);
  assert.equal(JSON.stringify(report).includes("Synthetic"), false);
});
test("dry-run downloads and validates images without ANY writer/storage/checkpoint calls", async () => {
  const s = setup(); let checkpoint = false;
  const result = await runSync({ ...options(s), mode: "dry-run", checkpoint: async () => { checkpoint = true; } });
  assert.equal(result.records, 6); assert.equal(result.media, 1); assert.equal(s.storage.puts, 0);
  assert.deepEqual(s.writer.calls, []); assert.equal(checkpoint, false);
});
test("stage releases lease without promote or checkpoint", async () => {
  const s = setup(); let checkpoint = false;
  const result = await runSync({ ...options(s), mode: "stage", checkpoint: async () => { checkpoint = true; } });
  assert.equal(result.outcome, "staged"); assert.equal(s.writer.records.size, 6); assert.equal(s.writer.current.size, 0);
  assert.equal(s.writer.calls.includes("promote"), false); assert.equal(s.writer.lease, null); assert.equal(checkpoint, false);
});
test("rename, UUID spelling and body edits preserve routes; reconcile does not depend on edited timestamp", async () => {
  const s = setup(); await runSync(options(s));
  const before = s.writer.current.get(DEMO.grandchild)!;
  const page = s.pages.get(DEMO.grandchild)!;
  page.properties.Name = { id: "title", type: "title", title: [{ ...((page.properties.Name as { title: unknown[] }).title[0] as object), plain_text: "Renamed", text: { content: "Renamed", link: null } }] } as typeof page.properties.Name;
  page.id = page.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  s.blocks.get(DEMO.child)!.push(demoParagraph(demoId(50000), DEMO.child, "Changed body without timestamp update"));
  await runSync(options(s));
  const after = s.writer.current.get(DEMO.grandchild)!;
  assert.equal(after.detail.item.id, before.detail.item.id); assert.equal(after.detail.item.href, before.detail.item.href);
  assert.equal(after.detail.item.title, "Renamed"); assert.equal(s.writer.current.get(DEMO.child)!.detail.document!.blocks.length, 2);
  const image = before.detail.document!.blocks.at(-1)!;
  assert.equal(s.storage.objects.size, 1); assert.deepEqual([...s.writer.media.keys()], [image.type === "image" ? image.image.id : "missing"]);
});
test("missing approval for an ancestor fails preflight before reading ANY body", async () => {
  const s = setup(); s.config.sources[2].publication.allowlistPageIds = [DEMO.child, DEMO.grandchild];
  await assert.rejects(runSync(options(s)), code("SCOPE_INCOMPLETE"));
  assert.equal(bodyReads(s).length, 0); assert.equal(s.writer.calls.includes("promote"), false);
});
test("central parent deny excludes descendants, links and images before body fetch", async () => {
  const s = setup(); s.writer.deniedPageIds = [DEMO.week];
  s.blocks.get(DEMO.course)!.push({ ...demoParagraph(DEMO.week, DEMO.course, ""), type: "child_page", child_page: { title: "Hidden" } } as BlockObjectResponse);
  const result = await runSync(options(s));
  assert.equal(result.records, 3); assert.equal(result.excluded, 3); assert.equal(result.media, 0);
  assert.equal(bodyReads(s).some(r => [DEMO.week, DEMO.child, DEMO.grandchild].includes(r.id)), false);
  const link = s.writer.current.get(DEMO.course)!.detail.document!.blocks.at(-1)!;
  assert.equal(link.type === "child-page" && link.target, null);
});
test("archived parent produces one fresh tombstone and excludes descendants", async () => {
  const s = setup(); s.pages.get(DEMO.week)!.archived = true;
  const result = await runSync(options(s));
  assert.equal(result.confirmedAbsent, 1); assert.equal(result.excluded, 3);
  assert.deepEqual([...s.writer.absences.values()], [{ id: DEMO.week, reason: "archived" }]);
  assert.equal(bodyReads(s).some(r => r.id === DEMO.child), false);
});
test("fresh foreign data source is explicit out-of-scope; descendants are excluded", async () => {
  const s = setup(); s.pages.get(DEMO.week)!.parent = { type: "data_source_id", data_source_id: demoId(888), database_id: demoId(999) };
  const result = await runSync(options(s)); assert.equal(result.excluded, 3);
  assert.deepEqual([...s.writer.absences.values()], [{ id: DEMO.week, reason: "out-of-scope" }]);
});
test("404 does not become deletion or advance the current snapshot/checkpoint", async () => {
  const s = setup(); await runSync(options(s)); const current = s.writer.current;
  s.pages.delete(DEMO.week); let checkpoints = 0;
  await assert.rejects(runSync({ ...options(s), checkpoint: async () => { checkpoints++; } }), code("SCOPE_INCOMPLETE"));
  assert.equal(s.writer.current, current); assert.equal(s.writer.absences.size, 0); assert.equal(checkpoints, 0);
});
test("wrong database_parent and wrong returned page identity fail preflight", async t => {
  await t.test("wrong source parent", async () => {
    const s = setup(); s.schemas.get(DEMO.notes)!.database_parent = { type: "page_id", page_id: demoId(999) };
    await assert.rejects(runSync(options(s)), code("SCOPE_INCOMPLETE")); assert.equal(bodyReads(s).length, 0);
  });
  await t.test("wrong response identity", async () => {
    const s = setup(); s.pages.get(DEMO.child)!.id = demoId(999);
    await assert.rejects(runSync(options(s)), code("SCOPE_INCOMPLETE")); assert.equal(bodyReads(s).length, 0);
  });
});
test("Status and course collection does not fetch ungranted outer containers", async () => {
  const s = setup(), outer = demoId(987654);
  for (const id of [DEMO.statuses, DEMO.courses]) {
    s.schemas.get(id)!.database_parent = { type: "block_id", block_id: outer };
  }
  const report = await runSync(options(s));
  assert.equal(report.records, 6);
  assert.equal(s.requests.some(r => r.category === "block" && r.id === outer), false);
  assert.equal(s.writer.current.get(DEMO.course)!.evidence.databaseParentId, null);
  assert.equal(s.writer.current.get(demoId(1000))!.evidence.databaseParentId, null);
  assert.equal(s.writer.current.get(DEMO.week)!.evidence.databaseParentId, DEMO.course);
});
test("second source page failure stops within bounds and is never promoted as an empty source", async () => {
  const s = setup(125); s.setFault((category, id, cursor) => category === "rows" && id === DEMO.statuses && cursor
    ? Response.json({ object: "error", code: "internal_server_error", message: "Synthetic" }, { status: 500 }) : undefined);
  await assert.rejects(runSync(options(s)), code("CONTENT_UNAVAILABLE"));
  // The SDK does not retry POST query on 500; rate-limit retries are tested separately.
  assert.equal(s.requests.filter(r => r.category === "rows" && r.cursor).length, 1);
  assert.equal(s.writer.calls.includes("promote"), false); assert.equal(bodyReads(s).length, 0);
});
test("429 and 529 source errors have at most three attempts and no promote", async () => {
  for (const status of [429, 529]) {
    const s = setup(); s.setFault(category => category === "rows" ? Response.json({ object: "error", status,
      code: status === 429 ? "rate_limited" : "service_overload", message: "Synthetic" }, { status, headers: { "Retry-After": "0" } }) : undefined);
    await assert.rejects(runSync(options(s)), code("RATE_LIMITED"));
    assert.equal(s.requests.filter(r => r.category === "rows").length, 3); assert.equal(s.writer.calls.includes("promote"), false);
  }
});
test("same image bytes on two owners deduplicate object keys while preserving owner-bound asset IDs", async () => {
  const s = setup(); s.config.sources[1].cover.strategy = "native-page-cover";
  s.pages.get(DEMO.course)!.cover = { type: "external", external: { url: "https://images.example.test/cover.png" } };
  const result = await runSync(options(s));
  assert.equal(result.media, 2); assert.equal(result.uniqueObjects, 1); assert.equal(s.storage.puts, 1);
  assert.equal(new Set([...s.writer.media.values()].map(m => m.ownerPageId)).size, 2);
  assert.equal(new Set([...s.writer.media.values()].map(m => m.objectKey)).size, 1);
});
test("empty scope is intentional only when configured; record and media limits fail closed", async t => {
  await t.test("disabled scope", async () => {
    const s = setup(); for (const source of s.config.sources) source.enabled = false;
    const result = await runSync(options(s)); assert.equal(result.records, 0); assert.equal(s.requests.length, 0);
  });
  await t.test("record budget", async () => {
    const s = setup(); await assert.rejects(runSync({ ...options(s), maxRecords: 1 }), code("LIMIT_EXCEEDED"));
    assert.equal(bodyReads(s).length, 0); assert.equal(s.writer.calls.includes("promote"), false);
  });
  await t.test("byte budget", async () => {
    const s = setup(); await assert.rejects(runSync({ ...options(s), maxMediaBytes: 1 }), code("LIMIT_EXCEEDED"));
    assert.equal(s.writer.calls.includes("promote"), false);
  });
});
test("block page failure and upload interruption retain the last complete snapshot", async t => {
  await t.test("body pagination", async () => {
    const s = setup(); await runSync(options(s)); const current = s.writer.current;
    s.setFault((category, id, cursor) => category === "blocks" && id === DEMO.week && cursor ? Response.json({ object: "error", code: "restricted_resource", message: "Synthetic" }, { status: 403 }) : undefined);
    await assert.rejects(runSync(options(s)), code("MISCONFIGURED")); assert.equal(s.writer.current, current);
  });
  await t.test("upload", async () => {
    const s = setup(); await runSync(options(s)); const current = s.writer.current;
    s.storage.put = async () => { throw new WorkerError("IMAGE_UNAVAILABLE"); };
    await assert.rejects(runSync(options(s)), code("IMAGE_UNAVAILABLE")); assert.equal(s.writer.current, current);
  });
});
test("unsupported block preserves partial, unknown ratings/dates remain null", async () => {
  const s = setup(); s.blocks.get(DEMO.course)!.push({ ...demoParagraph(demoId(60000), DEMO.course, ""), type: "audio", audio: { type: "external", external: { url: "https://example.test/audio" }, caption: [] } } as BlockObjectResponse);
  const result = await runSync(options(s)); assert.equal(result.partialDocuments, 1);
  const course = s.writer.current.get(DEMO.course)!.detail;
  assert.equal(course.document!.completeness, "partial"); assert.equal(course.item.kind === "course" && course.item.ratings.experience, null);
});
test("revision change during upload fences stage and prevents promotion", async () => {
  const s = setup(); const put = s.storage.put.bind(s.storage);
  s.storage.put = async (media, bytes) => { await put(media, bytes); s.writer.revision = "2"; };
  await assert.rejects(runSync(options(s)), code("LEASE_INVALID")); assert.equal(s.writer.current.size, 0);
});
test("cancellation during download prevents all later stage/promote/checkpoint operations", async () => {
  const s = setup(), controller = new AbortController();
  await assert.rejects(runSync({ ...options(s), signal: controller.signal, download: async () => { controller.abort(); return s.download(); } }), code("CANCELLED"));
  assert.equal(s.writer.calls.includes("promote"), false);
});
test("failed heartbeat aborts the run rather than using an expired lease", async () => {
  const s = setup(); s.writer.renew = async () => { throw new WorkerError("LEASE_INVALID"); };
  await assert.rejects(runSync({ ...options(s), leaseSeconds: 1, renewEveryMs: 5,
    download: async () => { await new Promise(r => setTimeout(r, 30)); return s.download(); } }), code("LEASE_INVALID"));
  assert.equal(s.writer.calls.includes("promote"), false);
});
test("checkpoint failure after successful promote is identified without undoing publication", async () => {
  const s = setup(); await assert.rejects(runSync({ ...options(s), checkpoint: async () => { throw new Error("Synthetic disk failure"); } }), code("CHECKPOINT_FAILED"));
  assert.equal(s.writer.current.size, 6); assert.equal(s.writer.calls.at(-1), "promote");
});
test("structural traversal limits and foreign block parents cannot be promoted as ordinary partial AST", async t => {
  await t.test("block conversion ceiling", async () => {
    const s = setup(0); s.blocks.set(DEMO.course, Array.from({ length: 3001 }, (_, n) => demoParagraph(demoId(70000 + n), DEMO.course, "Synthetic")));
    await assert.rejects(runSync(options(s)), code("LIMIT_EXCEEDED")); assert.equal(s.writer.calls.includes("promote"), false);
  });
  await t.test("wrong block parent", async () => {
    const s = setup(); s.blocks.get(DEMO.week)![0].parent = { type: "page_id", page_id: DEMO.private };
    await assert.rejects(runSync(options(s)), code("SCOPE_INCOMPLETE")); assert.equal(s.writer.current.size, 0);
  });
});
test("per-course node limit matches the database reader and is enforced before any body", async () => {
  const s = setup(0); s.config.sources[2].publication.allowlistPageIds = [];
  for (let n = 0; n < 5001; n++) {
    const id = demoId(80000 + n);
    s.pages.set(id, demoPage(id, `Synthetic node ${n}`, { type: "data_source_id", data_source_id: DEMO.notes, database_id: demoId(100) }));
    s.config.sources[2].publication.allowlistPageIds.push(id);
  }
  await assert.rejects(runSync(options(s)), code("LIMIT_EXCEEDED"));
  assert.equal(bodyReads(s).length, 0); assert.equal(s.writer.calls.includes("promote"), false);
});

test("manual sample stages a complete ancestor chain and media without publish or unrelated bodies", async () => {
  const s = setup(), selected = [demoId(1000), DEMO.course, DEMO.week, DEMO.child, DEMO.grandchild];
  const result = await runSync({ ...options(s), mode: "stage", stagePageIds: selected });
  assert.equal(result.sample,true); assert.equal(result.records,5); assert.equal(result.media,1);
  assert.deepEqual(new Set(s.writer.records.keys()),new Set(selected));
  assert.equal(s.storage.puts,1); assert.equal(s.writer.calls.includes("promote"),false);
  assert.equal(s.writer.lease,null); assert.equal(s.writer.current.size,0);
  assert.equal(bodyReads(s).some(r=>r.id===demoId(1001)),false);
  assert.equal(s.writer.absences.size,0);
});
test("samples cannot publish, omit ancestors, include unknown nodes or duplicates", async () => {
  for(const mode of ["publish","dry-run"] as const){const s=setup();await assert.rejects(runSync({...options(s),mode,stagePageIds:[DEMO.course]}),code("MISCONFIGURED"));assert.equal(s.writer.calls.length,0);}
  for(const selected of [[DEMO.child],[DEMO.course,DEMO.private]]){const s=setup();await assert.rejects(runSync({...options(s),mode:"stage",stagePageIds:selected}),code("SCOPE_INCOMPLETE"));assert.equal(bodyReads(s).length,0);assert.equal(s.storage.puts,0);assert.equal(s.writer.lease,null);}
  const s=setup();await assert.rejects(runSync({...options(s),mode:"stage",stagePageIds:[DEMO.course,DEMO.course]}),code("MISCONFIGURED"));assert.equal(s.writer.calls.length,0);
});
