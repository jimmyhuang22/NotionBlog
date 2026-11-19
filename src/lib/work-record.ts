import type { ContentBlock, ContentDocument, DateRange, TextRun } from "../../contracts/content.ts";

/**
 * Films' and books' records as their detail pages lay them out. Every record was written from one Notion template
 * per kind, so its headings are known: what the page shows elsewhere (a film's viewings) moves out of the body, the
 * outline, headings with nothing under them and an unused episode tracker are left out, a few headings take the
 * page's own words, and anything not recognised stays in the body exactly as written, so no text is ever dropped.
 */

const VIEWINGS = "多刷记录";
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

/** A sub-heading with nothing under it before the next heading of its rank or above (an empty "图片收集") says nothing. */
function unheaded(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((block, index) => {
    if (block.type !== "heading") return true;
    const next = blocks.slice(index + 1).find(other => !blank(other));
    return !!next && !(next.type === "heading" && next.level <= block.level);
  });
}

function trim(blocks: ContentBlock[]): ContentBlock[] {
  let start = 0, end = blocks.length;
  while (start < end && blank(blocks[start]!)) start++;
  while (end > start && blank(blocks[end - 1]!)) end--;
  return blocks.slice(start, end);
}

/** The sections that say something, tidied; `take` may claim a section for the page (it then leaves the body). */
function tidy(document: ContentDocument, renamed: Record<string, string>, take?: (title: string, section: Section) => boolean): Section[] {
  const kept: Section[] = [];
  for (const section of sections(document.blocks)) {
    const title = section.heading ? plain(section.heading.text) : null;
    if (title !== null && take?.(title, section)) continue;
    const blocks = section.blocks.filter(block => !untouched(block));
    if (section.heading && !says(blocks)) continue;
    const name = title !== null ? renamed[title] : undefined;
    kept.push({ heading: section.heading && name ? { ...section.heading, text: [{ text: name }] } : section.heading, blocks: unheaded(trim(blocks)).map(dated) });
  }
  return kept.filter(section => section.heading || section.blocks.length);
}

/** Sections back into one document; the outline keeps the headings that remain, under their new words. */
function assemble(document: ContentDocument, kept: Section[]): ContentDocument {
  const blocks = kept.flatMap(section => section.heading ? [section.heading, ...section.blocks] : section.blocks);
  const headings = new Map(blocks.flatMap(block => block.type === "heading" ? [[block.id, plain(block.text)] as const] : []));
  return { ...document, blocks, toc: document.toc.filter(entry => headings.has(entry.id)).map(entry => ({ ...entry, title: headings.get(entry.id)! })) };
}

/** One episode's note from a series' excerpts: its number, its name, and what was written about it. */
export interface EpisodeNote { number: number; name: string | null; text: string }

/** An episode heading as the template writes it: "Episode 1 - “Seven Thirty-Seven”" or "第 1 集 名字". */
const EPISODE = /^(?:Episode\s*(\d+)|第\s*(\d+)\s*集)\s*(?:[-–—:：·]\s*)?(.*)$/iu;

/**
 * A series' excerpts read as a list of episodes (2026-11-19, the owner's pick 甲): only when everything under
 * "摘录" is pairs of an episode heading and one quote or paragraph; anything else leaves the section as written.
 */
function readEpisodes(section: Section): EpisodeNote[] | null {
  const blocks = section.blocks.filter(block => !blank(block));
  if (!blocks.length || blocks.length % 2) return null;
  const notes: EpisodeNote[] = [];
  for (let index = 0; index < blocks.length; index += 2) {
    const heading = blocks[index]!, body = blocks[index + 1]!;
    if (heading.type !== "heading" || (body.type !== "quote" && body.type !== "paragraph")) return null;
    const match = EPISODE.exec(plain(heading.text));
    if (!match) return null;
    const name = match[3]!.replace(/^[“"「『]|[”"」』]$/gu, "").trim();
    notes.push({ number: Number(match[1] ?? match[2]), name: name || null, text: plain(body.text) });
  }
  return notes;
}

/** A film (the poster backdrop, 2026-11-19): the viewings table becomes the dates in the side column; "总结" reads "观后感". */
export interface MovieRecord {
  /** Each viewing, oldest first. Every date is one the source records; none is made up. */
  viewings: DateRange[];
  /** A series' excerpts, when they are all episode notes; they then leave the body. Empty otherwise. */
  episodes: EpisodeNote[];
  /** The body without what moved to the side; null when the body did not load, as the source said. */
  document: ContentDocument | null;
}

export function movieRecord(document: ContentDocument | null, watched: DateRange | null): MovieRecord {
  let table: DateRange[] = [];
  let episodes: EpisodeNote[] = [];
  const result = document ? assemble(document, tidy(document, { 总结: "观后感" }, (title, section) => {
    if (title === "摘录") {
      const read = readEpisodes(section);
      if (read) episodes = read;
      return !!read;
    }
    if (title !== VIEWINGS) return false;
    const read = readViewings(section);
    if (read) table = read;
    return !!read;
  })) : null;
  // The record's own date counts as a viewing when the table does not name that day, so the page never hides a
  // date the list files the work under (confirmed by the owner, 2026-11-19).
  const viewings = watched && !table.some(range => covers(range, watched.start)) ? [...table, watched] : table;
  return { viewings: viewings.sort((a, b) => day(a.start).localeCompare(day(b.start))), episodes, document: result };
}

/**
 * A book (the shelf and its reading, 2026-11-19): the excerpts are most of a book's record, so they come apart from
 * the rest and are shown as slips, each part of them headed with how many it holds. "感受 / 感想 / 书评" read
 * "读后感", the word the page uses when there is none; "梗概", "人物" and the like keep their own names.
 */
export interface BookRecord {
  /** What stands under "摘录", its part headings counted ("第一部 · 15 条"); null when there are none or the body did not load. */
  excerpts: ContentDocument | null;
  /** How many excerpts: list items and paragraphs under "摘录", not its headings. */
  excerptCount: number;
  /** Everything else; null when the body did not load, empty blocks when there is nothing else. */
  rest: ContentDocument | null;
}

const EXCERPTS = "摘录";
const items = (block: ContentBlock) => block.type === "list" ? block.items.length : block.type === "quote" || (block.type === "paragraph" && !blank(block)) ? 1 : 0;

/** An empty bullet is no excerpt: it would be an empty slip and a wrong count. */
function filled(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type !== "list") return [block];
    const kept = block.items.filter(item => plain(item.text) || item.children.length);
    return kept.length ? [{ ...block, items: kept }] : [];
  });
}

function counted(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block, index) => {
    if (block.type !== "heading") return block;
    let total = 0;
    for (const next of blocks.slice(index + 1)) {
      if (next.type === "heading") break;
      total += items(next);
    }
    return total ? { ...block, text: [{ text: `${plain(block.text)} · ${total} 条` }] } : block;
  });
}

export function bookRecord(document: ContentDocument | null): BookRecord {
  if (!document) return { excerpts: null, excerptCount: 0, rest: null };
  const kept = tidy(document, { 感受: "读后感", 感想: "读后感", 书评: "读后感" });
  const at = kept.findIndex(section => section.heading && plain(section.heading.text) === EXCERPTS);
  const found = at >= 0 ? { ...kept[at]!, blocks: filled(kept[at]!.blocks) } : null;
  const excerpts = found ? assemble(document, [{ heading: null, blocks: counted(found.blocks) }]) : null;
  return {
    excerpts,
    excerptCount: found ? found.blocks.reduce((sum, block) => sum + items(block), 0) : 0,
    rest: assemble(document, kept.filter((_, index) => index !== at)),
  };
}

/** A game (the key art across the page, 2026-11-19): the outline and empty headings go; every heading keeps the owner's words. */
export function gameRecord(document: ContentDocument | null): ContentDocument | null {
  return document ? assemble(document, tidy(document, {})) : null;
}

/**
 * Whether a book's excerpts open held to about a screen (ExcerptFold). One rule by count, the same on every width:
 * up to 30 are shown in full, more are held (2026-11-19, after the release check found 12 holding back a book of
 * 16 that the owner expects open; of the first 30 books, those over 30 run from 31 to 80 excerpts).
 */
export const EXCERPTS_SHOWN = 30;
export function excerptsHeld(count: number): boolean {
  return count > EXCERPTS_SHOWN;
}
