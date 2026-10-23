import type { ContentKind } from "../../contracts/content.ts";
import type { SearchHit } from "../../contracts/website.ts";
import { statusFocusHref } from "./status-focus.ts";

/** Sections a reader can narrow a search to, in navigation order, with the label shown on each result. */
export const searchKinds: [ContentKind, string][] = [
  ["status", "动态"], ["study-note", "笔记"], ["course", "课程"], ["post", "文章"], ["movie", "影视"],
  ["book", "书籍"], ["game", "游戏"], ["album", "相册"], ["project", "项目"], ["page", "关于"],
];

export const kindLabels: Record<string, string> = Object.fromEntries(searchKinds);
/** One character per kind for the search page's list marks, as the course overview marks its entries. */
export const kindMarks: Record<string, string> = { status: "动", "study-note": "记", course: "课", post: "文", movie: "影", book: "书", game: "游", album: "相", project: "项", page: "页" };

export const MAX_QUERY = 128;

/** The words to search for, as the search entry accepts them; null when there is nothing usable. */
export function readQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query.length > 0 && query.length <= MAX_QUERY && !/[\u0000-\u001f\u007f]/u.test(query) ? query : null;
}

/** A search address that keeps the words when the section changes. */
export function searchHref(query: string, kind: ContentKind | null): string {
  return `/search?${new URLSearchParams({ q: query, ...(kind ? { kind } : {}) })}`;
}

/** A status result must request its record, even when it is outside the first list page. */
export function searchResultHref(hit: Pick<SearchHit, "kind" | "id" | "href">): string {
  return hit.kind === "status" ? statusFocusHref(hit.id) : hit.href;
}

/** Course and parents distinguish duplicate titles for both keyboard and screen-reader users. */
export function searchResultLabel(hit: SearchHit): string {
  return [kindLabels[hit.kind] ?? "内容", hit.title, ...(hit.context ? [hit.context.courseLabel, ...hit.context.parentLabels] : [])].join("，");
}

/**
 * The text before, at and after the first place the query appears, ignoring case, so the match can
 * be marked. Null when it does not appear as written (a result can match on its title or a variant form).
 */
export function splitMatch(text: string, query: string): [string, string, string] | null {
  const at = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  // Case folding can change a string's length; only trust the position when it did not.
  if (at < 0 || text.toLocaleLowerCase().length !== text.length) return null;
  return [text.slice(0, at), text.slice(at, at + query.length), text.slice(at + query.length)];
}

/** Whether a key press should open quick search: "/" outside a text field, or Ctrl/⌘ + K anywhere. */
export function isSearchShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean }, typing: boolean): boolean {
  if (event.isComposing || event.altKey) return false;
  if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) return true;
  return event.key === "/" && !event.metaKey && !event.ctrlKey && !typing;
}

/** Arrow keys walk the options and wrap; -1 means nothing is chosen yet. */
export function stepOption(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * An excerpt is read, not parsed: a Markdown table that came through as text ("| 水果 | 蔬菜 |" and a
 * "| ---- |" rule) is folded into "（表格）" (T-06). Text with a stray "|" but no table rule is left alone.
 */
export function readableExcerpt(text: string): string {
  if (!/\|\s*:?-{3,}/u.test(text)) return text;
  const first = text.indexOf("|"), last = text.lastIndexOf("|");
  return `${text.slice(0, first).trimEnd()} （表格） ${text.slice(last + 1).trimStart()}`.trim();
}
