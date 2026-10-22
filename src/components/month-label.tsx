const names = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

/**
 * A timeline month as the site says it: "十月" in the hand font a step up, the year small beside it (T-02, the
 * owner's pick of 2026-10-20), so the month and the entry times below it read as two levels. The key is
 * "year-month"; anything else ("unknown") keeps its plain label.
 */
export function MonthLabel({ monthKey, label }: { monthKey: string; label: string }) {
  const match = /^(\d{4})-(\d{1,2})$/u.exec(monthKey);
  const name = match ? names[Number(match[2]) - 1] : undefined;
  if (!match || !name) return <>{label}</>;
  return <><span className="timeline__month-name">{name}</span> <span className="timeline__month-year">{match[1]}</span></>;
}
