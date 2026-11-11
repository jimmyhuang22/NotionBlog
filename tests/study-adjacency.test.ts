import assert from "node:assert/strict";
import test from "node:test";
import { ContentServiceError } from "../contracts/repository.ts";
import * as current from "../src/server/notion/study-incremental.ts";
import * as baseline from "./helpers/study-incremental-baseline.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { changedTime, largeStudyCheckpoint, smallStudyCheckpoint, studyItem, syntheticEntry,
  syntheticId as id, syntheticStudySource, type SyntheticStudySource } from "./helpers/study-adjacency-synthetic.ts";

type Implementation = Pick<typeof current, "prepareStudyDelta" | "applyStudyDelta" | "validateStudyCheckpoint">;
type SuccessfulRun = Awaited<ReturnType<typeof run>>;
interface Scenario {
  signals: number[];
  checkpoint?: current.StudyCheckpoint;
  mutate?(source: SyntheticStudySource): void;
  frozen?: ReadonlySet<string>;
  check?(result: SuccessfulRun): void;
}

async function run(implementation: Implementation, scenario: Scenario) {
  const checkpoint = structuredClone(scenario.checkpoint ?? smallStudyCheckpoint());
  const initial = structuredClone(checkpoint), fixture = syntheticStudySource(checkpoint);
  scenario.mutate?.(fixture);
  const delta = await implementation.prepareStudyDelta(checkpoint, scenario.signals.map(id), fixture.source, 2000, scenario.frozen);
  const restored = implementation.applyStudyDelta(checkpoint, delta, `${checkpoint.version}:next`);
  implementation.validateStudyCheckpoint(restored);
  assert.deepEqual(checkpoint, initial, "Preparing and applying must not mutate the caller's checkpoint");
  return { delta, restored, calls: fixture.calls };
}

function compare(name: string, scenario: Scenario): void {
  test(`Map + push preserves complete worker output: ${name}`, async () => {
    const expected = await run(baseline, scenario), actual = await run(current, scenario);
    // Includes idempotency key, withdrawal evidence, href changes, complete documents,
    // tree order, applied checkpoint, and every source read with its read options.
    assert.deepEqual(actual, expected);
    scenario.check?.(actual);
  });
}

function setBody(source: SyntheticStudySource, key: number, text: string): void {
  const entry = source.current.get(id(key))!;
  entry.record.detail.document!.blocks = [{ id: "body", type: "paragraph", text: [{ text }] }];
  studyItem(entry).updatedAt = changedTime;
}

compare("unchanged leaf", { signals: [13], check: result => {
  assert.equal(result.delta.upserts.length, 0); assert.equal(result.delta.withdrawals.length, 0);
} });
compare("changed body", { signals: [13], mutate: source => setBody(source, 13, "Changed body"), check: result => {
  assert.deepEqual(result.delta.upserts.map(entry => studyItem(entry).id), [id(13)]);
} });
compare("renamed parent and incoming links", { signals: [12], mutate: source => {
  studyItem(source.current.get(id(12))!).title = "Renamed"; source.rebuild();
}, check: result => {
  const linking = result.restored.entries.find(entry => studyItem(entry).id === id(11))!.record.detail.document!;
  assert.ok(linking.blocks.some(block => block.type === "child-page" && block.target?.title === "Renamed"));
  assert.equal(linking.toc[0].title, "Renamed");
} });
compare("subtree withdrawal", { signals: [10], mutate: source => source.withdrawn.set(id(10), "archived"), check: result => {
  assert.deepEqual(result.delta.withdrawals, [10, 12, 13, 14].map(id));
  assert.deepEqual(result.delta.withdrawalEvidence, [{ id: id(10), sourceKey: "notes", reason: "archived" }]);
} });
compare("ancestor deny", { signals: [1], mutate: source => source.withdrawn.set(id(1), "denied"), check: result => {
  assert.deepEqual(new Set(result.delta.withdrawals), new Set([1, 10, 11, 12, 13, 14].map(id)));
  assert.deepEqual(result.restored.entries.map(entry => studyItem(entry).id), [id(2), id(20)]);
  assert.equal(result.delta.withdrawalEvidence[0].reason, "denied");
} });
compare("same-course move", { signals: [12], mutate: source => source.move(id(12), id(11)), check: result => {
  assert.equal(result.restored.entries.find(entry => studyItem(entry).id === id(12))!.record.evidence.parentId, id(11));
  assert.equal(result.delta.withdrawals.length, 0);
} });
compare("cross-course move", { signals: [12], mutate: source => source.move(id(12), id(20)), check: result => {
  for (const key of [12, 13]) {
    const item = studyItem(result.restored.entries.find(entry => studyItem(entry).id === id(key))!);
    assert.equal(item.kind, "study-note"); if (item.kind === "study-note") assert.equal(item.courseId, id(2));
  }
  assert.deepEqual(result.delta.directories.map(directory => directory.courseId), [id(1), id(2)]);
} });
compare("ancestor withdrawn while a signalled descendant moves out", { signals: [10, 12], mutate: source => {
  source.withdrawn.set(id(10), "archived"); source.move(id(12), id(11));
}, check: result => {
  assert.deepEqual(result.delta.withdrawals, [10, 14].map(id));
  assert.ok(result.restored.entries.some(entry => studyItem(entry).id === id(13)));
} });
const nullLinkCheckpoint = smallStudyCheckpoint();
nullLinkCheckpoint.entries.find(entry => studyItem(entry).id === id(11))!.record.detail.document!.blocks.push({
  id: "unavailable", type: "child-page", title: "Old missing title", target: null,
});
compare("empty href map retains unavailable-link normalization", { signals: [13], checkpoint: nullLinkCheckpoint, check: result => {
  assert.equal(result.delta.hrefChanges.length, 0);
  assert.ok(result.delta.upserts.some(entry => studyItem(entry).id === id(11)));
} });
compare("root numeric override reorders ordinals", { signals: [11], mutate: source => {
  source.current.get(id(11))!.override = -1; source.rebuild();
}, check: result => {
  assert.equal(result.delta.directories[0].tree!.nodes[0].id, id(11));
} });
compare("changed dependent version refreshes its body", { signals: [12], mutate: source => {
  studyItem(source.current.get(id(12))!).title = "Renamed"; setBody(source, 13, "New dependent body"); source.rebuild();
}, check: result => {
  assert.ok(result.calls.some(([key, options]) => key === id(13) && options.document));
} });
compare("new child updates its parent directory", { signals: [15], mutate: source => {
  source.current.set(id(15), syntheticEntry(15, id(1), id(12), 16, 1)); source.rebuild();
}, check: result => {
  assert.ok(result.restored.entries.some(entry => studyItem(entry).id === id(15)));
} });
compare("missing frozen child remains in the checkpoint", { signals: [12], frozen: new Set([id(13)]), mutate: source => {
  source.current.delete(id(13)); source.rebuild();
}, check: result => {
  assert.ok(result.restored.entries.some(entry => studyItem(entry).id === id(13)));
  assert.equal(result.calls.some(([key]) => key === id(13)), false);
} });

test("Map + push preserves subtree restoration after an earlier committed withdrawal", async () => {
  const original = smallStudyCheckpoint();
  const removed = await run(baseline, { checkpoint: original, signals: [10], mutate: source => source.withdrawn.set(id(10), "archived") });
  const scenario: Scenario = { checkpoint: removed.restored, signals: [10], mutate: source => {
    for (const entry of original.entries) if ([10, 12, 13, 14].map(id).includes(studyItem(entry).id)) {
      source.current.set(studyItem(entry).id, structuredClone(entry));
    }
    source.rebuild();
  } };
  const expected = await run(baseline, scenario), actual = await run(current, scenario);
  assert.deepEqual(actual, expected);
  for (const key of [10, 12, 13, 14]) assert.ok(actual.delta.upserts.some(entry => studyItem(entry).id === id(key)));
  assert.equal(actual.delta.withdrawals.length, 0);
});
compare("mixed ten-level subtree", { signals: [1000], checkpoint: largeStudyCheckpoint(200, "mixed"),
  mutate: source => source.withdrawn.set(id(1000), "archived"), check: result => {
    assert.equal(result.delta.withdrawals.length, 50);
    assert.equal(result.restored.entries.length, 154);
  } });
compare("wide sibling set", { signals: [1511], checkpoint: largeStudyCheckpoint(512, "wide"),
  mutate: source => source.withdrawn.set(id(1511), "archived"), check: result => {
    assert.deepEqual(result.delta.withdrawals, [id(1511)]);
    assert.equal(result.delta.upserts.length, 0);
    assert.equal(result.delta.directories[0].pages, 511);
  } });

async function rejection(implementation: Implementation, scenario: Scenario) {
  const checkpoint = structuredClone(scenario.checkpoint ?? smallStudyCheckpoint());
  const initial = structuredClone(checkpoint), source = syntheticStudySource(checkpoint); scenario.mutate?.(source);
  let failure: unknown;
  try { await implementation.prepareStudyDelta(checkpoint, scenario.signals.map(id), source.source, 2000, scenario.frozen); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof ContentServiceError, "Invalid input must fail closed with a content service error");
  assert.deepEqual(checkpoint, initial);
  return { error: { code: failure.code, name: failure.name, message: failure.message }, calls: source.calls };
}

test("Map + push refuses withdrawing an ancestor of a frozen descendant", async () => {
  const scenario: Scenario = { signals: [10], frozen: new Set([id(13)]), mutate: source => source.withdrawn.set(id(10), "archived") };
  assert.deepEqual(await rejection(current, scenario), await rejection(baseline, scenario));
});
for (const invalid of ["missing-parent", "cycle", "wrong-course"] as const) test(`Map + push rejects invalid checkpoint: ${invalid}`, async () => {
  const checkpoint = smallStudyCheckpoint(), entry = checkpoint.entries.find(entry => studyItem(entry).id === id(12))!;
  const item = studyItem(entry); assert.equal(item.kind, "study-note");
  if (item.kind !== "study-note") throw new Error("Expected a note");
  entry.record.evidence.parentId = item.parentId = id(invalid === "missing-parent" ? 999 : invalid === "cycle" ? 13 : 20);
  const scenario = { signals: [12], checkpoint };
  const expected = await rejection(baseline, scenario), actual = await rejection(current, scenario);
  assert.deepEqual(actual, expected); assert.equal(actual.calls.length, 0);
});

test("Map + push application still rejects a partial subtree withdrawal with a valid digest", async () => {
  const checkpoint = smallStudyCheckpoint();
  const result = await run(baseline, { checkpoint, signals: [10], mutate: source => source.withdrawn.set(id(10), "archived") });
  const delta = structuredClone(result.delta); delta.withdrawals = delta.withdrawals.filter(key => key !== id(13));
  const { baseVersion, sourceDigest, upserts, withdrawals, withdrawalEvidence, hrefChanges, directories } = delta;
  delta.idempotencyKey = configDigest({ baseVersion, sourceDigest, upserts, withdrawals, withdrawalEvidence, hrefChanges, directories });
  for (const implementation of [baseline, current]) {
    assert.throws(() => implementation.applyStudyDelta(checkpoint, delta, "v2"), ContentServiceError);
  }
});
