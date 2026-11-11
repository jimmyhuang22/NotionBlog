/** Offline only: node --expose-gc --require ./scripts/development/offline-network.cjs scripts/performance/study-tree-adjacency.ts */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as baseline from "../../tests/helpers/study-incremental-baseline.ts";
import * as push from "../../src/server/notion/study-incremental.ts";
import { largeStudyCheckpoint, syntheticId, syntheticStudySource } from "../../tests/helpers/study-adjacency-synthetic.ts";

const implementations = { baseline, push };
type Variant = keyof typeof implementations;
const variants: Variant[] = ["baseline", "push"];
const median = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
const cases: { notes: number; shape: "wide" | "mixed" }[] = [
  { notes: 500, shape: "wide" }, { notes: 5000, shape: "wide" },
  { notes: 15000, shape: "wide" }, { notes: 15000, shape: "mixed" },
];
const results = [];
for (const { notes, shape } of cases) {
  const checkpoint = largeStudyCheckpoint(notes, shape), fixture = syntheticStudySource(checkpoint);
  const last = syntheticId(1000 + notes - 1), signals = [last]; fixture.withdrawn.set(last, "archived");
  const expected = await baseline.prepareStudyDelta(checkpoint, signals, fixture.source, 2000);
  const expectedCalls = structuredClone(fixture.calls), restored = baseline.applyStudyDelta(checkpoint, expected, "v2");
  fixture.calls.length = 0;
  // Untimed complete equivalence/warmup pass on this exact performance corpus.
  const actual = await push.prepareStudyDelta(checkpoint, signals, fixture.source, 2000);
  assert.deepEqual(actual, expected); assert.deepEqual(fixture.calls, expectedCalls);
  assert.deepEqual(push.applyStudyDelta(checkpoint, actual, "v2"), restored);
  assert.deepEqual(expected.withdrawals, [last]); assert.ok(expected.upserts.length <= 100);
  const samples: Record<Variant, { prepareMs: number[]; applyMs: number[] }> = {
    baseline: { prepareMs: [], applyMs: [] }, push: { prepareMs: [], applyMs: [] },
  };
  for (let repeat = 0; repeat < 3; repeat++) for (let index = 0; index < variants.length; index++) {
    const variant = variants[(repeat + index) % variants.length], implementation = implementations[variant];
    fixture.calls.length = 0; global.gc?.();
    const prepareStart = performance.now();
    const delta = await implementation.prepareStudyDelta(checkpoint, signals, fixture.source, 2000);
    samples[variant].prepareMs.push(performance.now() - prepareStart);
    assert.deepEqual(delta, expected); assert.deepEqual(fixture.calls, expectedCalls);
    global.gc?.();
    const applyStart = performance.now();
    const applied = implementation.applyStudyDelta(checkpoint, delta, "v2");
    samples[variant].applyMs.push(performance.now() - applyStart);
    assert.deepEqual(applied, restored);
  }
  results.push({ notes, shape, checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
    completeDeltaAndAppliedCheckpointEqual: true, sourceReadTraceEqual: true,
    output: { reads: expected.reads, upserts: expected.upserts.length, withdrawals: expected.withdrawals.length,
      deltaBytes: Buffer.byteLength(JSON.stringify(expected)) }, samples,
    medianMs: Object.fromEntries(variants.map(variant => [variant, {
      prepare: median(samples[variant].prepareMs), apply: median(samples[variant].applyMs),
    }])) });
}
const sha256 = (relative: string) => createHash("sha256").update(readFileSync(new URL(relative, import.meta.url))).digest("hex");
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  baselineCommit: "ec3ef10fda7e7d52c49955985a392f3bb5703abf",
  hashes: { baselineHelper: sha256("../../tests/helpers/study-incremental-baseline.ts"),
    currentImplementation: sha256("../../src/server/notion/study-incremental.ts") },
  method: "Actual prepareStudyDelta and applyStudyDelta, measured separately. One untimed complete equality pass, three timed samples with alternating variant order and optional GC before each phase. Fixture creation, equality checks, and source trace comparisons are outside timings. Sources are synthetic in-memory records; no cloud or production worker measurements.",
  limitation: "Leaf withdrawal leaves the full checkpoint validation, cloning, rewriting, ordering, and serialization costs intact. Mixed depth is at most ten. No timing assertion; these are local CPU/wall measurements, not website response latency.",
  forcedGc: Boolean(global.gc), cases: results,
}, null, 2));
