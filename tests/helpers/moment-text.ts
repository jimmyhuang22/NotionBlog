import type { MomentLabel } from "../../src/lib/format.ts";

/** A moment as the page reads it, in one string: "昨天 · 10 月 13 日 22:52", "今天 09:12", "10 月 5 日" (EntryMoment draws the same parts). */
export function momentText(moment: MomentLabel): string {
  if (!moment.relative) return moment.rest ?? "";
  if (!moment.rest) return moment.relative;
  return moment.relative === "今天" ? `${moment.relative} ${moment.rest}` : `${moment.relative} · ${moment.rest}`;
}
