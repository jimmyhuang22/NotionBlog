import type { ContentBlock, ContentDocument, ImageAsset, StatusEntry, StatusYears, TextRun } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { dateParts } from "../format.ts";

export interface StatusReadOptions { timeZone?: string | (() => string) }
export function statusTimeZone(options: StatusReadOptions = {}): string {
  const zone = typeof options.timeZone === "function" ? options.timeZone() : options.timeZone ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); }
  catch { throw new ContentServiceError("MISCONFIGURED", "Invalid site time zone."); }
  return zone;
}
export function statusYear(item: StatusEntry, timeZone: string): number | null {
  const date = item.recordedAt;
  return date ? dateParts(date.start, date.precision, timeZone)?.year ?? null : null;
}
export function statusYears(items: StatusEntry[], timeZone: string): StatusYears {
  const counts = new Map<number, number>();
  let undatedCount = 0;
  for (const item of items) {
    const year = statusYear(item, timeZone);
    if (year === null) undatedCount++;
    else counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return { years: [...counts].sort(([a], [b]) => b - a).map(([year, count]) => ({ year, count })), undatedCount, timeZone };
}

/** Derive after authorization/redaction, without changing the stored worker DTO. */
export function statusPreview(item: StatusEntry, document: ContentDocument | null): StatusEntry {
  const images: ImageAsset[] = [];
  const paragraphs: string[] = [];
  let hasMoreBody = document === null || document.completeness === "partial";
  function visit(blocks: ContentBlock[]) {
    for (const block of blocks) {
      if (block.type === "paragraph") paragraphs.push(block.text.map(run => run.text).join(""));
      else if (block.type === "image") {
        if (images.length < 9) images.push(block.image);
        else hasMoreBody = true;
        if (block.caption.some(run => run.text.trim())) hasMoreBody = true;
      } else hasMoreBody = true;
      if ("children" in block) visit(block.children);
      if (block.type === "list") for (const row of block.items) visit(row.children);
      if (block.type === "columns") for (const column of block.columns) visit(column.blocks);
    }
  }
  if (document) visit(document.blocks);
  if (paragraphs.length && paragraphs.join("\n").trim() !== item.text.map(run => run.text).join("").trim()) hasMoreBody = true;
  // Never retain a preview from an earlier projection when the current body is absent.
  const { previewBody: _oldPreview, previewBodyTruncated: _oldTruncated, ...base } = item;
  const preview = document ? statusBodyPreview(document.blocks) : undefined;
  return { ...base, images, hasMoreBody, ...(preview ? {
    previewBody: preview.blocks, previewBodyTruncated: preview.truncated,
  } : {}) };
}

const PREVIEW_CHARACTERS = 400;
const PREVIEW_NODES = 12;
const PREVIEW_DEPTH = 3;
const PREVIEW_RUNS = 40;
const PREVIEW_BYTES = 8192;

/** Text-only prefix of an already authorized/redacted AST. Never loads content. */
export function statusBodyPreview(blocks: ContentBlock[]): { blocks: ContentBlock[]; truncated: boolean } | undefined {
  let characters = 0, nodes = 0, runs = 0, structured = false, truncated = false, stopped = false, paragraphs = 0;
  function text(input: TextRun[]): TextRun[] {
    const result: TextRun[] = [];
    for (const run of input) {
      if (!run.text) continue;
      const room = PREVIEW_CHARACTERS - characters;
      if (!room || runs >= PREVIEW_RUNS) { truncated = true; stopped = true; break; }
      // Code points avoid cutting an emoji surrogate pair. Inline formulae stay whole.
      let selected = "", count = 0;
      for (const point of run.text) { if (count === room) break; selected += point; count++; }
      const clipped = selected.length < run.text.length;
      if (run.equation && clipped) { truncated = true; stopped = true; break; }
      const copy = { ...run, ...(run.link ? { link: { ...run.link } } : {}), text: selected };
      if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > PREVIEW_BYTES) { truncated = true; stopped = true; break; }
      result.push(copy); characters += count; runs++;
      if (Object.entries(run).some(([key, value]) => key !== "text" && value !== false && value !== undefined && value !== "default")) structured = true;
      if (clipped) { truncated = true; stopped = true; break; }
    }
    return result;
  }
  function visit(input: ContentBlock[], depth: number): ContentBlock[] {
    const output: ContentBlock[] = [];
    for (const block of input) {
      if (stopped) { truncated = true; break; }
      // Media, code, display formulae, tables and link cards keep their detail-only representation.
      if (!["paragraph", "heading", "quote", "callout", "toggle", "list", "divider", "columns"].includes(block.type)) continue;
      if (depth > PREVIEW_DEPTH || nodes >= PREVIEW_NODES) { truncated = true; stopped = true; break; }
      nodes++;
      if (block.type !== "paragraph") structured = true;
      if (block.type === "paragraph") paragraphs++;
      let selected: ContentBlock | undefined;
      switch (block.type) {
        case "paragraph": case "heading": case "quote": {
          const value = text(block.text);
          if (value.length) selected = { ...block, text: value };
          break;
        }
        case "divider": selected = { ...block }; break;
        case "callout": {
          const value = text(block.text), children = visit(block.children, depth + 1);
          if (value.length || children.length) selected = { ...block, text: value, children };
          break;
        }
        case "toggle": {
          const title = text(block.title), children = visit(block.children, depth + 1);
          if (title.length || children.length) selected = { ...block, title, children };
          break;
        }
        case "list": {
          const items: Extract<ContentBlock, { type: "list" }>["items"] = [];
          for (const row of block.items) {
            if (stopped || nodes >= PREVIEW_NODES) { truncated = true; stopped = true; break; }
            nodes++;
            const value = text(row.text), children = visit(row.children, depth + 1);
            if (value.length || children.length) items.push({ ...row, text: value, children });
          }
          if (items.length) selected = { ...block, items };
          break;
        }
        case "columns": {
          const columns: Extract<ContentBlock, { type: "columns" }>["columns"] = [];
          for (const column of block.columns) {
            if (stopped) { truncated = true; break; }
            const children = visit(column.blocks, depth + 1);
            if (children.length) columns.push({ ratio: column.ratio, blocks: children });
          }
          if (columns.length) selected = { ...block, columns };
          break;
        }
      }
      if (selected) {
        if (new TextEncoder().encode(JSON.stringify([...output, selected])).byteLength > PREVIEW_BYTES) { truncated = true; stopped = true; break; }
        output.push(selected);
      }
    }
    return output;
  }
  const result = visit(blocks, 1);
  // A short plain paragraph already has the same representation in text.
  return result.length && (structured || paragraphs > 1 || truncated)
    ? { blocks: result, truncated } : undefined;
}
