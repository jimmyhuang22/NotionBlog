import type { StatusYears } from "../../contracts/content.ts";

/** A year filter as the list endpoints take it: a year, the records without a date, or everything. */
export type YearChoice = number | "undated" | null;

/** Only a value the list endpoints accept is passed on; anything else shows every year. */
export function readYear(value: string | string[] | undefined): YearChoice {
  if (value === "undated") return "undated";
  return typeof value === "string" && /^[1-9][0-9]{0,3}$/u.test(value) ? Number(value) : null;
}

export interface YearTab { value: string | null; label: string; count: number }

/** Everything, each year that has records (newest first, as counted), then the undated ones when there are any. */
export function yearTabs(years: StatusYears): YearTab[] {
  return [
    { value: null, label: "全部", count: yearTotal(years, null) },
    ...years.years.map(entry => ({ value: String(entry.year), label: String(entry.year), count: entry.count })),
    ...(years.undatedCount > 0 ? [{ value: "undated", label: "无日期", count: years.undatedCount }] : []),
  ];
}

/** How many records the choice covers, from the counts alone. */
export function yearTotal(years: StatusYears, choice: YearChoice): number {
  if (choice === "undated") return years.undatedCount;
  if (choice === null) return years.years.reduce((sum, entry) => sum + entry.count, 0) + years.undatedCount;
  return years.years.find(entry => entry.year === choice)?.count ?? 0;
}

/** Whether the counts know the choice; a year with no records under the current filter is not offered. */
export function hasYear(years: StatusYears, choice: YearChoice): boolean {
  return choice === null || yearTotal(years, choice) > 0;
}
