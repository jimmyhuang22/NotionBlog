import type { ContentBlock, ContentDocument, ContentKind, ImageAsset, StatusEntry } from "../../contracts/content.ts";
import type { PublicContentSnapshot } from "../../contracts/website.ts";
import { ContentServiceError } from "../../contracts/repository.ts";
import { statusPreview } from "../../src/lib/content/status.ts";
import type { ThumbnailWidth } from "../../src/server/database/thumbnail-index.ts";
import type { MediaSourceVersion } from "../../src/server/media/notion-source.ts";
import { safeMediaUrl } from "../../src/server/notion/media.ts";

const KINDS: readonly ContentKind[] = ["post", "status", "album", "book", "movie", "game", "course", "study-note", "project", "page"];
const MEDIA_PATH = /^\/media\/(v2\/)?(a1\.[a-f0-9]{64})$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_RECORDS = 20_000;
const MAX_BLOCKS = 200_000;
const MAX_AST_ENTRIES = 1_000_000;
const MAX_AST_CHARACTERS = 32 * 1024 * 1024;
const MAX_DEPTH = 32;
interface TraversalBudget { blocks: number; entries: number; characters: number }

export interface ThumbnailCandidate {
  assetId: string;
  ownerPageId: string;
  neededWidths: ThumbnailWidth[];
  kinds: ContentKind[];
  /** Selected image-field occurrences, before asset de-duplication. */
  occurrences: number;
}
export interface ThumbnailSelection {
  assets: ThumbnailCandidate[];
  directExternalOccurrences: number;
  /** Input completeness counts for all enabled records. */
  unloadedDocuments: number;
  partialDocuments: number;
  recordsConsidered: number;
}

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail coverage input is invalid.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) unavailable();
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200_000 && !value.includes("\0");
}
function boundedText(value: unknown, budget?: TraversalBudget): value is string {
  if (!text(value)) return false;
  if (budget && (budget.characters += value.length) > MAX_AST_CHARACTERS) unavailable();
  return true;
}
function array(value: unknown, maximum = 20_000, budget?: TraversalBudget): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) unavailable();
  if (budget && (budget.entries += value.length + 1) > MAX_AST_ENTRIES) unavailable();
  return value;
}
function identity(value: unknown): value is string { return typeof value === "string" && ID.exec(value)?.[0] === value; }
function runs(value: unknown, budget?: TraversalBudget): void {
  for (const entry of array(value, 20_000, budget)) {
    const run = object(entry);
    keys(run, ["text"], ["equation", "bold", "italic", "code", "underline", "strike", "color", "link"]);
    if (!boundedText(run.text, budget) || (run.equation !== undefined && run.equation !== true)) unavailable();
    for (const key of ["bold", "italic", "code", "underline", "strike"]) if (run[key] !== undefined && typeof run[key] !== "boolean") unavailable();
    if (run.color !== undefined && !["default", "muted", "accent", "warning"].includes(run.color as string)) unavailable();
    if (run.link !== undefined) {
      const link = object(run.link);
      if (link.kind === "external") { keys(link, ["kind", "url"]); if (!boundedText(link.url, budget)) unavailable(); }
      else if (link.kind === "internal") { keys(link, ["kind", "href"]); if (!boundedText(link.href, budget)) unavailable(); }
      else if (link.kind === "unavailable") keys(link, ["kind"]);
      else unavailable();
    }
  }
}

/** Validate only the known AST shape, without qualifying any image or following links. */
function validateBlocks(value: unknown, budget: TraversalBudget, depth = 0, active = new Set<object>()): void {
  if (depth > MAX_DEPTH) unavailable();
  const blocks = array(value, 20_000, budget);
  if (active.has(blocks)) unavailable();
  active.add(blocks);
  try {
    for (const entry of blocks) {
      if (++budget.blocks > MAX_BLOCKS) unavailable();
      const block = object(entry);
      if (!identity(block.id)) unavailable();
      const check = (fields: string[]) => keys(block, ["id", "type", ...fields]);
      const children = (child: unknown) => validateBlocks(child, budget, depth + 1, active);
      const richText = (value: unknown) => runs(value, budget);
      const string = (value: unknown) => boundedText(value, budget);
      switch (block.type) {
        case "paragraph": case "quote": check(["text"]); richText(block.text); break;
        case "heading": check(["level", "text"]); if (![1, 2, 3].includes(block.level as number)) unavailable(); richText(block.text); break;
        case "list":
          check(["ordered", "items"]); if (typeof block.ordered !== "boolean") unavailable();
          for (const entry of array(block.items, 20_000, budget)) {
            const item = object(entry); keys(item, ["id", "text", "checked", "children"]);
            if (!identity(item.id) || (item.checked !== null && typeof item.checked !== "boolean")) unavailable();
            richText(item.text); children(item.children);
          }
          break;
        case "callout": check(["tone", "icon", "text", "children"]);
          if (!["default", "info", "warning"].includes(block.tone as string) || (block.icon !== null && !string(block.icon))) unavailable();
          richText(block.text); children(block.children); break;
        case "toggle": check(["title", "children"]); richText(block.title); children(block.children); break;
        case "columns": check(["columns"]);
          for (const entry of array(block.columns, 20_000, budget)) {
            const column = object(entry); keys(column, ["ratio", "blocks"]);
            if (column.ratio !== null && (typeof column.ratio !== "number" || !Number.isFinite(column.ratio) || column.ratio < 0)) unavailable();
            children(column.blocks);
          }
          break;
        // Image identity is checked by select(), after this bounded AST walk.
        case "image": check(["image", "caption"]); richText(block.caption); break;
        case "code": check(["language", "code", "caption"]); if (!string(block.language) || !string(block.code)) unavailable(); richText(block.caption); break;
        case "table": check(["hasColumnHeader", "hasRowHeader", "rows"]);
          if (typeof block.hasColumnHeader !== "boolean" || typeof block.hasRowHeader !== "boolean") unavailable();
          for (const row of array(block.rows, 20_000, budget)) for (const cell of array(row, 20_000, budget)) richText(cell);
          break;
        case "bookmark": check(["title", "url", "description"]); if (!string(block.title) || !string(block.url) || (block.description !== null && !string(block.description))) unavailable(); break;
        case "embed": check(["url", "title", "display"]); if (!string(block.url) || !string(block.title) || !["link", "iframe"].includes(block.display as string)) unavailable(); break;
        case "child-page": check(["title", "target"]); if (!string(block.title)) unavailable();
          if (block.target !== null) { const target = object(block.target); keys(target, ["title", "href"]); if (!string(target.title) || !string(target.href)) unavailable(); }
          break;
        case "equation": check(["expression"]); if (!string(block.expression)) unavailable(); break;
        case "unsupported": check(["label"]); if (!string(block.label)) unavailable(); break;
        case "divider": case "table-of-contents": check([]); break;
        default: unavailable();
      }
    }
  } finally { active.delete(blocks); }
}

function documentImages(blocks: ContentBlock[], visit: (image: ImageAsset) => void): void {
  for (const block of blocks) {
    if (block.type === "image") visit(block.image);
    else if (block.type === "list") for (const item of block.items) documentImages(item.children, visit);
    else if (block.type === "callout" || block.type === "toggle") documentImages(block.children, visit);
    else if (block.type === "columns") for (const column of block.columns) documentImages(column.blocks, visit);
  }
}

/** Offline UI coverage only. A projected snapshot is an input, never new authorization. */
export function selectThumbnailCandidates(snapshot: PublicContentSnapshot, version: MediaSourceVersion, enabledKinds: readonly ContentKind[]): ThumbnailSelection {
  try {
    if (!["v1", "v2"].includes(version) || !Array.isArray(enabledKinds) || enabledKinds.length > KINDS.length ||
        Array.from(enabledKinds).some(kind => !KINDS.includes(kind)) || new Set(enabledKinds).size !== enabledKinds.length) unavailable();
    const root = object(snapshot); keys(root, ["version", "records"]);
    if (!text(root.version) || !root.version || root.version.length > 256) unavailable();
    const records = array(root.records, MAX_RECORDS), enabled = new Set(enabledKinds), owners = new Set<string>();
    const result: ThumbnailSelection = { assets: [], directExternalOccurrences: 0, unloadedDocuments: 0, partialDocuments: 0, recordsConsidered: 0 };
    const assets = new Map<string, ThumbnailCandidate>(), budget: TraversalBudget = { blocks: 0, entries: 0, characters: 0 };
    function select(value: unknown, owner: string, kind: ContentKind, widths: ThumbnailWidth[]): void {
      const image = object(value); keys(image, ["id", "src", "alt", "width", "height"]);
      if (!text(image.id) || !image.id || !text(image.src) || !text(image.alt) ||
          [image.width, image.height].some(d => d !== null && (typeof d !== "number" || !Number.isFinite(d) || d < 0))) unavailable();
      const match = MEDIA_PATH.exec(image.src);
      if (!match || match[0] !== image.src) {
        // Preserve deliberately direct public HTTPS URLs; never turn them into
        // a database identity or fetch them to discover one.
        if (/[\u0000-\u0020\u007f\\]/u.test(image.src) || !image.src.startsWith("https://")) unavailable();
        const safe = safeMediaUrl(image.src);
        if (!safe) unavailable();
        const url = new URL(safe);
        if (url.protocol !== "https:" || url.hash || (url.port && url.port !== "443") || url.hostname.endsWith(".")) unavailable();
        result.directExternalOccurrences++;
        return;
      }
      const sourceVersion = match[1] ? "v2" : "v1", assetId = match[2];
      if (sourceVersion !== version || image.id !== assetId) unavailable();
      const prior = assets.get(assetId);
      if (prior) {
        if (prior.ownerPageId !== owner) unavailable();
        prior.occurrences++;
        prior.neededWidths = [...new Set([...prior.neededWidths, ...widths])].sort((a, b) => a - b);
        if (!prior.kinds.includes(kind)) prior.kinds.push(kind);
      } else {
        if (assets.size >= 20_000) unavailable();
        assets.set(assetId, { assetId, ownerPageId: owner, neededWidths: [...widths], kinds: [kind], occurrences: 1 });
      }
    }
    for (const entry of records) {
      const detail = object(entry); keys(detail, ["item", "document"], ["adjacent"]);
      const item = object(detail.item), kind = item.kind as ContentKind;
      if (!KINDS.includes(kind) || !identity(item.id) || owners.has(item.id) || !Object.hasOwn(item, "cover")) unavailable();
      owners.add(item.id);
      let document: ContentDocument | null = null;
      if (detail.document !== null) {
        const body = object(detail.document); keys(body, ["blocks", "toc", "completeness"]);
        array(body.blocks); array(body.toc);
        if (!["complete", "partial"].includes(body.completeness as string)) unavailable();
        document = body as unknown as ContentDocument;
      }
      if (!enabled.has(kind)) continue;
      result.recordsConsidered++;
      if (!document) result.unloadedDocuments++;
      else if (document.completeness === "partial") result.partialDocuments++;
      if (document) validateBlocks(document.blocks, budget);
      if (kind === "status" || kind === "album") {
        if (kind === "status") {
          runs(item.text, budget);
          for (const image of statusPreview(item as unknown as StatusEntry, document).images!) select(image, item.id, kind, [400]);
          if (item.cover !== null) select(item.cover, item.id, kind, [800]);
        } else {
          if (item.cover !== null) select(item.cover, item.id, kind, [400, 800]);
        }
      } else if (["book", "movie", "game", "post", "project"].includes(kind)) {
        if (item.cover !== null) select(item.cover, item.id, kind, [400, 800]);
      } else if (kind === "course" && item.cover !== null) select(item.cover, item.id, kind, [800]);
      // Full readable bodies need 800 previews, including Status images beyond
      // the nine-image list preview. Album grids also retain their 400 cap.
      if (document) documentImages(document.blocks, image => select(image, item.id as string, kind, kind === "album" ? [400, 800] : [800]));
    }
    result.assets = [...assets.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
    return result;
  } catch { return unavailable(); }
}
