import test from "node:test";
import assert from "node:assert/strict";
import { hasYear, readYear, yearTabs, yearTotal } from "../src/lib/year-filter.ts";

const years = { years: [{ year: 2026, count: 12 }, { year: 2024, count: 3 }], undatedCount: 2, timeZone: "UTC" };

test("only values the list endpoints accept become a year choice", () => {
  assert.equal(readYear("2026"), 2026);
  assert.equal(readYear("undated"), "undated");
  for (const value of [undefined, "", "0", "026", "20260", "2026a", "-1", ["2026"], ["2026", "2025"]]) assert.equal(readYear(value), null);
});

test("the tabs are everything, the counted years in their order, then the undated records", () => {
  assert.deepEqual(yearTabs(years), [
    { value: null, label: "全部", count: 17 },
    { value: "2026", label: "2026", count: 12 },
    { value: "2024", label: "2024", count: 3 },
    { value: "undated", label: "无日期", count: 2 },
  ]);
  assert.deepEqual(yearTabs({ ...years, undatedCount: 0 }).map(tab => tab.value), [null, "2026", "2024"]);
});

test("a choice counts what it covers, and a year without records is not known", () => {
  assert.equal(yearTotal(years, null), 17);
  assert.equal(yearTotal(years, 2024), 3);
  assert.equal(yearTotal(years, 2025), 0);
  assert.equal(yearTotal(years, "undated"), 2);
  assert.equal(hasYear(years, null), true);
  assert.equal(hasYear(years, 2026), true);
  assert.equal(hasYear(years, 2025), false);
  assert.equal(hasYear({ ...years, undatedCount: 0 }, "undated"), false);
});
