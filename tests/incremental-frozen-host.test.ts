import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hostFixture } from "./helpers/incremental-host.ts";
import { DEMO, demoParagraph, demoId } from "../scripts/notion-sync/demo.ts";
import { installFreeze } from "../scripts/website-sync/freeze-migration.ts";
import { createFreezeStore } from "../src/server/database/freeze.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { createRuntimeSources } from "../scripts/website-incremental-sync/runtime-sources.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { parseIncrementalArguments } from "../scripts/website-incremental-sync/cli.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

test("the actual host skips frozen pages, refreshes one group and recovers a lost committed refresh without replay", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const owner: SqlExecutor = {async query<T>(sql: string, values?: unknown[]) {
    if (sql.startsWith("-- Opt-in")) { await f.db.exec(sql); return {rows: [] as T[]}; }
    return f.db.query<T>(sql, values);
  }};
  assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
  await installFreeze(owner); await f.db.query("UPDATE nb_freeze.state SET enabled=true");
  const store = createFreezeStore(owner), plan = await store.preview(DEMO.course, "freeze");
  const frozen = await store.freeze(crypto.randomUUID(), plan, []);
  assert.equal(plan.pages, 2);
  const snapshot = async () => (await owner.query<{result: unknown}>("SELECT nb_publication_api.read_snapshot($1::text[],true) AS result", [["course", "study-note"]])).rows[0].result;
  const before = await snapshot();
  const keys = f.config.sources.map(s => s.key);
  const queue = await openIncrementalQueue(join(f.options.runtimeDirectory, "queue"), {digest: f.digest, sourceKeys: keys});
  try {
    queue.enqueue(plan.members.map((m, index) => ({eventId: `frozen-${index}`, sourceKey: m.sourceKey, pageKey: m.id, reason: "reconcile", observedAt: Date.now()})));
  } finally { queue.close(); }
  f.demo.pages.get(DEMO.course)!.archived = true;
  f.demo.pages.get(DEMO.week)!.archived = true;
  const requested: string[] = [];
  const deps = {...f.deps, sources: async (input: Parameters<typeof f.deps.sources>[0]) => createRuntimeSources({...input, token: "synthetic",
    fetch: async (url, init) => { requested.push(new URL(String(url)).pathname); return f.fetcher(url, init); },
    scheduler: new NotionRequestScheduler({intervalMs: 0}),
    storage: {read: async () => {throw Error("No fixture media");}, put: async () => {throw Error("No fixture media");}},
  })};
  const skipped = await runIncrementalHost({...f.options, command: "run", freezeEnabled: true}, deps);
  assert.equal(skipped.outcome, "unchanged", JSON.stringify(skipped));
  assert.equal(skipped.queue?.pending, 0);
  assert.ok(requested.every(path => !path.includes(`/pages/${DEMO.course}`) && !path.includes(`/pages/${DEMO.week}`) && !path.includes(`/blocks/${DEMO.course}`) && !path.includes(`/blocks/${DEMO.week}`)));
  assert.deepEqual(await snapshot(), before);

  f.demo.pages.get(DEMO.course)!.archived = false;
  f.demo.pages.get(DEMO.week)!.archived = false;
  f.demo.pages.get(DEMO.week)!.last_edited_time = "2026-10-27T00:00:00Z";
  f.demo.blocks.set(DEMO.week, [demoParagraph(demoId(300), DEMO.week, "Refreshed frozen content")]);
  const selected = plan.members.find(m => m.id === DEMO.course)!;
  const once = await store.preview(DEMO.course, "once");
  let lost = false;
  const uncertain = {...deps, database: async (...args: Parameters<NonNullable<typeof f.deps.database>>) => {
    const db = await f.deps.database!(...args);
    return {...db, writer: {async query<T>(sql: string, values?: unknown[]) {
      const result = await db.writer.query<T>(sql, values);
      if (!lost && sql.includes("nb_freeze_api.refresh_delta")) { lost = true; throw Error("Synthetic lost commit reply"); }
      return result;
    }}};
  }};
  const result = await runIncrementalHost({...f.options, command: "run", freezeEnabled: true,
    target: {sourceKey: selected.sourceKey, pageKey: selected.id}, refreshFrozenGroup: frozen.groupId,
    expectedFreezeGeneration: once.generation, expectedPublicationRevision: once.publicationRevision}, uncertain);
  assert.equal(lost, true, JSON.stringify(result));
  assert.equal(result.outcome, "blocked", JSON.stringify(result));
  assert.equal(result.queue?.awaiting_verification, 1);
  const generation = (await store.state()).generation;
  const calls = f.counts.sourceCalls;
  const recovered = await runIncrementalHost({...f.options, command: "recover", freezeEnabled: true}, {...deps, sources: async () => assert.fail("Recovery must not read Notion or media")});
  assert.equal(recovered.outcome, "recovered", JSON.stringify(recovered));
  assert.equal(recovered.recovered, 1);
  assert.equal(f.counts.sourceCalls, calls);
  assert.equal((await store.state()).generation, generation);
  assert.equal((await store.state()).members.length, 2);
  assert.match(JSON.stringify(await snapshot()), /Refreshed frozen content/);
});

test("queue target selection cannot consume another page, and frozen hints are not runnable", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const queue = await openIncrementalQueue(join(f.root, "target-queue"), {digest: f.digest, sourceKeys: ["status"]});
  try {
    queue.enqueue(["a", "b"].map(id => ({eventId: id, sourceKey: "status", pageKey: id, reason: "reconcile", observedAt: 0})));
    queue.setFrozenPages(new Set(["a"]));
    assert.equal(queue.enqueue([{eventId: "ignored", sourceKey: "status", pageKey: "a", reason: "content", observedAt: 1}]), 0);
    assert.equal(queue.status().pending, 1);
    assert.deepEqual(queue.claim(1, 120000, {target: {sourceKey: "status", pageKey: "a"}}), []);
    const [selected] = queue.claim(1, 120000, {target: {sourceKey: "status", pageKey: "b"}});
    assert.equal(selected.pageKey, "b"); queue.completeUnchanged(selected);
    queue.setFrozenPages(new Set());
    assert.equal(queue.status().pending, 1);
    assert.equal(queue.claim(1)[0].pageKey, "a");
  } finally { queue.close(); }
});

test("the CLI distinguishes a real targeted run from resume and refuses partial target flags", () => {
  const common = ["--config", "/fiction/config.json", "--lock-dir", "/fiction/locks", "--runtime-dir", "/fiction/runtime"];
  const result = parseIncrementalArguments(["run", ...common, "--source", "notes", "--page", DEMO.week]);
  assert.deepEqual("target" in result ? result.target : null, {sourceKey: "notes", pageKey: DEMO.week});
  assert.throws(() => parseIncrementalArguments(["run", ...common, "--source", "notes"]));
  assert.throws(() => parseIncrementalArguments(["recover", ...common, "--source", "notes", "--page", DEMO.week]));
  assert.throws(() => parseIncrementalArguments(["run", ...common, "--refresh-group", crypto.randomUUID()]));
});
