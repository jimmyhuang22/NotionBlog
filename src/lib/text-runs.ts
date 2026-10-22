import type { TextRun } from "../../contracts/content.ts";

/**
 * The same runs without the blank space before the first word and after the last. Text taken from a
 * page often ends in a line break or two; shown with its line breaks kept, that would leave an empty
 * line at the bottom of a card. Breaks inside the text are the author's and stay.
 */
export function trimRuns(runs: TextRun[]): TextRun[] {
  let start = 0, end = runs.length;
  while (start < end && !runs[start]!.text.trim()) start += 1;
  while (end > start && !runs[end - 1]!.text.trim()) end -= 1;
  return runs.slice(start, end).map((run, index, kept) => {
    let text = run.text;
    if (index === 0) text = text.trimStart();
    if (index === kept.length - 1) text = text.trimEnd();
    return text === run.text ? run : { ...run, text };
  });
}

/**
 * How long a text reads, as the "展开全文 · 约 N 字" label says it: characters without white space,
 * exact under a hundred, else to the nearest hundred.
 */
export function readingLength(runs: TextRun[]): number {
  const count = [...runs.map(run => run.text).join("").replace(/\s+/gu, "")].length;
  return count < 100 ? count : Math.round(count / 100) * 100;
}
