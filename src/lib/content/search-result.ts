import type { AnyContent, ContentKind, ImageAsset } from "../../../contracts/content.ts";
import type { SearchHit, SearchHitDetails } from "../../../contracts/website.ts";
import { withoutSearchTemplateHeadings } from "../search.ts";

const BEFORE_MATCH = 16;
const EXCERPT_LENGTH = 180;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const searchKey = (text: string) => text.normalize("NFKC").toLocaleLowerCase();

/** Map a normalized offset back to the original text, including width and ligature changes. */
function sourceOffset(text: string, offset: number): number {
  let foldedLength = 0;
  for (const { index, segment } of segmenter.segment(text)) {
    foldedLength += searchKey(segment).length;
    if (foldedLength > offset) return index;
  }
  return text.length;
}

export function searchExcerpt(body: string, needle: string, titleMatch: boolean): string {
  if (titleMatch) return "";
  const text = withoutSearchTemplateHeadings(body);
  const folded = searchKey(text), offset = folded.indexOf(needle);
  if (offset < 0) return "";
  let start = folded === text ? offset : sourceOffset(text, offset);
  for (let before = 0; before < BEFORE_MATCH && start > 0; before++) {
    start -= (text.codePointAt(start - 2) ?? 0) > 0xffff ? 2 : 1;
  }
  // A code point takes at most two UTF-16 units. Slice a bounded window before
  // counting it, so long documents never allocate a second full character array.
  const excerpt = Array.from(text.slice(start, start + EXCERPT_LENGTH * 2)).slice(0, EXCERPT_LENGTH).join("");
  return `${start ? "…" : ""}${excerpt.trim()}${start + excerpt.length < text.length ? "…" : ""}`;
}

export const SEARCH_DETAIL_KINDS: ReadonlySet<ContentKind> = new Set(["game", "book", "movie", "album", "status"]);

function displayCover(asset: ImageAsset | null | undefined): ImageAsset | null {
  if (!asset || !/^a1\.[0-9a-f]{64}$/u.test(asset.id) || asset.src !== `/media/v2/${asset.id}`) return null;
  const { id, src, alt, width, height, delivery } = asset;
  return { id, src, alt, width, height, ...(delivery ? { delivery: {
    mode: delivery.mode, maxWidth: delivery.maxWidth, maxHeight: delivery.maxHeight,
  } } : {}) };
}

/** Expose only the site's existing display-media reference and the public list facts. */
export function searchHitDetails(item: AnyContent): Pick<SearchHit, "cover" | "details"> {
  let details: SearchHitDetails;
  switch (item.kind) {
    case "game": details = { kind: item.kind, status: item.status, platforms: item.platforms, playedTime: item.playedTime, rating: item.rating }; break;
    case "book": details = { kind: item.kind, authors: item.authors, status: item.status }; break;
    case "movie": details = { kind: item.kind, mediaType: item.mediaType, status: item.status }; break;
    case "album": details = { kind: item.kind, date: item.date, photoCount: item.photoCount }; break;
    case "status": details = { kind: item.kind, recordedAt: item.recordedAt }; break;
    default: return {};
  }
  return { cover: displayCover(item.kind === "status" ? item.images?.[0] : item.cover), details };
}
