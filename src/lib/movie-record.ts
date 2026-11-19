import type { ContentBlock, ContentDocument, DateRange, TextRun } from "../../contracts/content.ts";

/**
 * A film's record as the detail page lays it out (the owner's pick of 2026-11-19, the poster backdrop): every
 * record was written from one Notion template, so its headings are known. The viewings table becomes the dates
 * in the side column; the outline and headings with nothing under them are left out; "总结" reads "观后感".
 * Anything not recognised stays in the body exactly as written, so no text is ever dropped.
 */
export interface MovieRecord {
  /** Each viewing, oldest first. Every date is one the source records; none is made up. */
  viewings: DateRange[];
  /** The body without what moved to the side; null when the body did not load, as the source said. */
  document: ContentDocument | null;
}

const VIEWINGS = "多刷记录";
const RENAMED: Record<string, string> = { 总结: "观后感" };
const DATE = /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/g;

const plain = (runs: TextRun[]) => runs.map(run => run.text).join("").trim();
const blank = (block: ContentBlock) => block.type === "paragraph" && !plain(block.text);

interface Section { heading: Extract<ContentBlock, { type: "heading" }> | null; blocks: ContentBlock[] }

function sections(blocks: ContentBlock[]): Section[] {
  const out: Section[] = [{ heading: null, blocks: [] }];
  for (const block of blocks) {
    if (block.type === "table-of-contents") continue;
    if (block.type === "heading" && block.level === 1) out.push({ heading: block, blocks: [] });
    else out.at(-1)!.blocks.push(block);
  }
  return out;
}

/** The dates of one row: one date is a day, two or more are the first to the last. A row with no date is null. */
function rowDates(cells: TextRun[][]): DateRange | null | "unreadable" {
  // The first cell is the row's number ("1", "2"); the rest hold the dates.
  const text = cells.slice(1).map(plain).join(" ").trim();
  if (!text) return null;
  const days = [...text.matchAll(DATE)].map(([, year, month, day]) => `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`);
  if (!days.length) return "unreadable";
  return { start: days[0]!, end: days.length > 1 ? days.at(-1)! : null, precision: "date" };
}

/** The viewings table, read only when it is nothing but dates; anything else leaves the section in the body. */
function readViewings(section: Section): DateRange[] | null {
  const content = section.blocks.filter(block => !blank(block));
  if (!content.length || content.some(block => block.type !== "table")) return null;
  const dates: DateRange[] = [];
  for (const table of content as Extract<ContentBlock, { type: "table" }>[]) {
    for (const row of table.rows) {
      const read = rowDates(row);
      if (read === "unreadable") return null;
      if (read) dates.push(read);
    }
  }
  return dates;
}

const day = (value: string) => value.slice(0, 10);
const covers = (range: DateRange, value: string) => day(range.start) <= day(value) && day(value) <= day(range.end ?? range.start);

/**
 * The template's episode tracker: numbered checkboxes, often in columns ("1" to "24"). Left with nothing ticked it
 * was never used and says nothing; once any box is ticked it is the owner's and stays.
 */
function untouched(block: ContentBlock): boolean {
  if (block.type === "list") return block.items.length > 0 && block.items.every(item => item.checked === false && !item.children.length && /^\d+$/.test(plain(item.text)));
  if (block.type === "columns") return block.columns.some(column => column.blocks.length > 0) && block.columns.every(column => column.blocks.every(inner => blank(inner) || untouched(inner)));
  return false;
}

/** A sub-heading that is only a date ("2024/04/03", the day a part was written) reads as the site writes dates. */
function dated(block: ContentBlock): ContentBlock {
  if (block.type !== "heading") return block;
  const match = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(plain(block.text));
  return match ? { ...block, text: [{ text: `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` }] } : block;
}

/** A heading with only other headings and empty lines under it says nothing yet. */
const says = (blocks: ContentBlock[]) => blocks.some(block => block.type !== "heading" && !blank(block));

function trim(blocks: ContentBlock[]): ContentBlock[] {
  let start = 0, end = blocks.length;
  while (start < end && blank(blocks[start]!)) start++;
  while (end > start && blank(blocks[end - 1]!)) end--;
  return blocks.slice(start, end);
}

export function movieRecord(document: ContentDocument | null, watched: DateRange | null): MovieRecord {
  let table: DateRange[] = [];
  let result: ContentDocument | null = null;
  if (document) {
    const kept: ContentBlock[] = [];
    for (const section of sections(document.blocks)) {
      const title = section.heading ? plain(section.heading.text) : null;
      if (title === VIEWINGS) {
        const read = readViewings(section);
        if (read) { table = read; continue; }
      }
      if (section.heading && !says(section.blocks.filter(block => !untouched(block)))) continue;
      const blocks = trim(section.blocks.filter(block => !untouched(block))).map(dated);
      if (section.heading) {
        const name = RENAMED[title!];
        kept.push(name ? { ...section.heading, text: [{ text: name }] } : section.heading);
      }
      kept.push(...blocks);
    }
    const headings = new Map(kept.flatMap(block => block.type === "heading" ? [[block.id, plain(block.text)] as const] : []));
    result = {
      ...document,
      blocks: kept,
      toc: document.toc.filter(entry => headings.has(entry.id)).map(entry => ({ ...entry, title: headings.get(entry.id)! })),
    };
  }
  // The record's own date counts as a viewing when the table does not name that day, so the page never hides a
  // date the list files the work under (2026-11-19; the owner was asked about the records where the two disagree).
  const viewings = watched && !table.some(range => covers(range, watched.start)) ? [...table, watched] : table;
  return { viewings: viewings.sort((a, b) => day(a.start).localeCompare(day(b.start))), document: result };
}
