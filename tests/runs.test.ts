import assert from "node:assert/strict";
import test from "node:test";
import { runsBy } from "../src/lib/runs.ts";

test("items under the same heading form a run in the order given, and a heading that comes back starts a new run", () => {
  const head = (year: number | null) => year === null ? { key: "unknown", label: "日期未记录" } : { key: String(year), label: `${year}` };
  const items = [{ id: "a", year: 2026 }, { id: "b", year: 2026 }, { id: "c", year: 2025 }, { id: "d", year: null }, { id: "e", year: null }];
  assert.deepEqual(runsBy(items, item => head(item.year)).map(run => `${run.label}:${run.items.map(item => item.id).join("")}`), ["2026:ab", "2025:c", "日期未记录:de"]);
  // An order the endpoint did not promise is shown as it came, not hidden by merging distant runs.
  assert.deepEqual(runsBy([items[2]!, items[0]!, items[2]!], item => head(item.year)).map(run => run.key), ["2025", "2026", "2025"]);
  // The heading is taken from the first item of its run.
  assert.deepEqual(runsBy([{ k: "x", n: 1 }, { k: "x", n: 2 }], item => ({ key: item.k, first: item.n })).map(run => run.first), [1]);
  assert.deepEqual(runsBy([], () => ({ key: "" })), []);
});
