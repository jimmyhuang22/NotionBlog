/** Offline only: node scripts/performance/social-timeline-grouping.ts. No credentials or network. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { socialTimelineSql } from "../../src/server/social/timeline-repository.ts";
import { baselineSocialTimelineSql } from "../../tests/helpers/social-timeline-baseline.ts";
import { createSyntheticTimelineDatabase, seedSyntheticTimeline } from "../../tests/helpers/social-timeline-synthetic.ts";

const db = await createSyntheticTimelineDatabase();
try {
  const scenarios = [];
  for (const works of [50, 500]) {
    await seedSyntheticTimeline(db, works, 20);
    const queries = { baseline: baselineSocialTimelineSql(), grouped: socialTimelineSql };
    const timings: Record<keyof typeof queries, number[]> = { baseline: [], grouped: [] };
    assert.deepEqual((await db.query(queries.baseline)).rows, (await db.query(queries.grouped)).rows);
    for (let pass = 0; pass < 4; pass++) for (const key of pass % 2 ? ["grouped", "baseline"] as const : ["baseline", "grouped"] as const) {
      const started = performance.now(); await db.query(queries[key]);
      if (pass) timings[key].push(performance.now() - started);
    }
    const plans: Record<string, unknown> = {};
    for (const key of ["baseline", "grouped"] as const) {
      const result = await db.query<{ "QUERY PLAN": unknown }>("EXPLAIN (ANALYZE,FORMAT JSON) " + queries[key]);
      plans[key] = result.rows[0]!["QUERY PLAN"];
    }
    scenarios.push({ works, publications: works * 20, equal: true, timings,
      medianMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, [...values].sort((a, b) => a - b)[1]])), plans });
  }
  console.log(JSON.stringify({ node: process.version, engine: "PGlite", limitations: "Synthetic query-shape benchmark; excludes production RLS/view costs and network. Not end-to-end latency.", scenarios }, null, 2));
} finally { await db.close(); }
