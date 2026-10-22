import { createHash } from "node:crypto";
import type { ApiColor, BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type {
  ContentBlock, ContentDocument, ContentLink, ImageAsset, TextLink, TextRun,
} from "../../../contracts/content.ts";
import { normalizeId } from "./config.ts";
import { isNotionPageHost, isTemporaryMediaUrl, sanitizePublicText } from "./public-text.ts";
import type { NotionReadClient } from "./types.ts";

/** Raw media locations stay inside this server-side callback. */
export interface RegisterBlockImageInput {
  ownerPageId: string;
  blockId?: string;
  /** Private v2 locator hint; a fresh complete sibling read must prove membership. */
  blockParentId?: string;
  property?: string;
  alt: string;
  url: string;
  expiryTime?: string;
  width?: number;
  height?: number;
}

export interface BlockConversionContext {
  /** Opt-in v2 AST addition; frozen v1 collectors retain the original TextRun shape. */
  inlineEquations?: boolean;
  /** Website v2 accepts browser-equivalent encoded image paths; v1 stays unchanged. */
  canonicalImageUrls?: boolean;
  /** Website v2 can carry stable external video links; frozen v1 stays unchanged. */
  externalVideos?: boolean;
  /** The resolver must independently authorize the target page. */
  resolvePageLink(pageId: string): Promise<ContentLink | null>;
  /** Optional v2 course navigation coverage; independently verifies database ownership. */
  isCourseDatabaseRepresented?(databaseId: string): Promise<boolean>;
  /** Return a stable app media path, never the source's signed URL. */
  registerImage(input: RegisterBlockImageInput): Promise<ImageAsset | null>;
  maxDepth?: number;
  maxBlocks?: number;
}

const internalNotionHost = isNotionPageHost;

const safeHttpUrl = (value: string): URL | null => {
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password ? url : null;
  } catch { return null; }
};

const safeAppPath = (value: string) => value.startsWith("/") &&
  !value.startsWith("//") && !/[\u0000-\u0020\u007f\\]/u.test(value);

function canonicalImageUrl(value: string): string | null {
  // Encode spaces within a path/query. Do not normalize controls, backslashes,
  // leading/trailing whitespace, credentials or a malformed URL authority.
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value) ||
      !/^https?:\/\/[^\s/?#]+(?:[/?#]|$)/i.test(value)) return null;
  try { const url = new URL(value); return safeHttpUrl(url.href) ? url.href : null; } catch { return null; }
}

function pageIdFromUrl(url: URL): string | null {
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  const lastSegment = path.split("/").filter(Boolean).at(-1) ?? "";
  const candidate = lastSegment.match(/(?:^|-)([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i)?.[1]
    ?? url.searchParams.get("p");
  if (!candidate || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(candidate)) return null;
  return normalizeId(candidate);
}

async function resolvedPage(id: string, context: BlockConversionContext): Promise<ContentLink | null> {
  const target = await context.resolvePageLink(normalizeId(id));
  return target && safeAppPath(target.href) ? { title: safeText(target.title), href: target.href } : null;
}

/** Public links allow HTTP(S), or an authorized Notion target's app route. */
export async function resolveNotionTextLink(
  value: string,
  context: BlockConversionContext,
): Promise<TextLink> {
  const url = safeHttpUrl(value);
  if (!url || isTemporaryMediaUrl(url)) return { kind: "unavailable" };
  if (internalNotionHost(url.hostname)) {
    const pageId = pageIdFromUrl(url);
    const target = pageId ? await resolvedPage(pageId, context) : null;
    return target ? { kind: "internal", href: target.href } : { kind: "unavailable" };
  }
  return { kind: "external", url: url.href };
}

/** Literal Notion locations can also occur in a linked run's display text. */
const safeText = sanitizePublicText;

function textColor(color: ApiColor): NonNullable<TextRun["color"]> {
  const foreground = color.replace(/_background$/, "");
  if (foreground === "default") return "default";
  if (foreground === "gray") return "muted";
  return ["red", "orange", "yellow"].includes(foreground) ? "warning" : "accent";
}

/** Reused for Status text fields; no raw mention object crosses the boundary. */
export async function convertNotionRichText(
  richText: RichTextItemResponse[],
  context: BlockConversionContext,
  fallbackColor: ApiColor = "default",
): Promise<TextRun[]> {
  const runs: TextRun[] = [];
  for (const rich of richText) {
    const text = rich.type === "equation" ? rich.equation.expression
      : rich.type === "text" ? rich.text.content : rich.plain_text;
    const { bold, italic, code, underline, strikethrough, color } = rich.annotations;
    const run: TextRun = {
      text: safeText(text),
      ...(rich.type === "equation" && context.inlineEquations ? { equation: true as const } : {}),
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(code ? { code: true } : {}),
      ...(underline ? { underline: true } : {}),
      ...(strikethrough ? { strike: true } : {}),
      color: textColor(color === "default" ? fallbackColor : color),
    };
    if (rich.type === "mention" && rich.mention.type === "page") {
      const target = await resolvedPage(rich.mention.page.id, context);
      run.text = target?.title ?? "Unavailable page";
      run.link = target ? { kind: "internal", href: target.href } : { kind: "unavailable" };
    } else if (rich.type === "mention" && rich.mention.type === "database") {
      run.text = "Unavailable page";
      run.link = { kind: "unavailable" };
    } else {
      const href = rich.type === "text" ? rich.text.link?.url ?? rich.href : rich.href;
      if (href) run.link = await resolveNotionTextLink(href, context);
    }
    runs.push(run);
  }
  return runs;
}

function publicBlockId(id: string): string {
  return `block-${createHash("sha256").update(id.replaceAll("-", "").toLowerCase()).digest("hex").slice(0, 24)}`;
}

type ListBlock = Extract<BlockObjectResponse, { type: "bulleted_list_item" | "numbered_list_item" | "to_do" }>;
const isListBlock = (block: BlockObjectResponse): block is ListBlock =>
  block.type === "bulleted_list_item" || block.type === "numbered_list_item" || block.type === "to_do";

/** Pagination belongs to the read client; recursion never crosses child pages. */
export async function buildNotionDocument(
  pageId: string,
  client: NotionReadClient,
  context: BlockConversionContext,
): Promise<ContentDocument> {
  const ownerPageId = normalizeId(pageId);
  const document: ContentDocument = { blocks: [], toc: [], completeness: "complete" };
  const seen = new Set<string>();
  let count = 0;
  const bounded = (value: number | undefined, fallback: number, ceiling: number) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
  const maxDepth = bounded(context.maxDepth, 24, 64);
  const maxBlocks = bounded(context.maxBlocks, 3000, 10000);
  const linkCache = new Map<string, Promise<ContentLink | null>>();
  const scopedContext: BlockConversionContext = {
    ...context,
    resolvePageLink(id) {
      const normalized = normalizeId(id);
      let promise = linkCache.get(normalized);
      if (!promise) {
        promise = context.resolvePageLink(normalized);
        linkCache.set(normalized, promise);
      }
      return promise;
    },
  };
  const text = (rich: RichTextItemResponse[], color: ApiColor = "default") =>
    convertNotionRichText(rich, scopedContext, color);
  const unsupported = (id: string, label: string): ContentBlock => {
    document.completeness = "partial";
    return { id: publicBlockId(id), type: "unsupported", label };
  };
  const omittedChildren = (block: BlockObjectResponse): ContentBlock[] => block.has_children
    ? [unsupported(`${block.id}-children`, "Nested content is not supported for this block")] : [];

  function claim(block: BlockObjectResponse, parentId: string): ContentBlock | null {
    if (count >= maxBlocks) return unsupported(`${parentId}-limit`, "Content block limit reached");
    const id = normalizeId(block.id);
    const parent = block.parent;
    const belongsHere = (parent.type === "page_id" && normalizeId(parent.page_id) === parentId) ||
      (parent.type === "block_id" && normalizeId(parent.block_id) === parentId);
    if (!belongsHere) return unsupported(block.id, "Content belongs to a different parent");
    if (seen.has(id)) return unsupported(`${block.id}-repeat`, "Repeated content block omitted");
    seen.add(id);
    count++;
    return null;
  }

  async function children(block: BlockObjectResponse, depth: number): Promise<ContentBlock[]> {
    return block.has_children ? await convertChildren(normalizeId(block.id), depth + 1) : [];
  }

  async function convertChildren(parentId: string, depth: number): Promise<ContentBlock[]> {
    if (depth > maxDepth) return [unsupported(`${parentId}-depth`, "Content nesting limit reached")];
    const source = await client.listBlocks(parentId);
    const output: ContentBlock[] = [];
    let currentList: Extract<ContentBlock, { type: "list" }> | null = null;
    let currentListType: ListBlock["type"] | null = null;
    for (const block of source) {
      if (block.in_trash || block.archived) continue;
      const failure = claim(block, parentId);
      if (failure) {
        output.push(failure);
        currentList = null;
        currentListType = null;
        if (count >= maxBlocks) break;
        continue;
      }
      if (isListBlock(block)) {
        if (!currentList || currentListType !== block.type) {
          currentList = { id: `${publicBlockId(block.id)}-list`, type: "list", ordered: block.type === "numbered_list_item", items: [] };
          currentListType = block.type;
          output.push(currentList);
        }
        const payload = block.type === "to_do" ? block.to_do
          : block.type === "numbered_list_item" ? block.numbered_list_item : block.bulleted_list_item;
        if (block.type === "numbered_list_item" &&
          ((block.numbered_list_item.list_start_index !== undefined && block.numbered_list_item.list_start_index !== 1) ||
            (block.numbered_list_item.list_format !== undefined && block.numbered_list_item.list_format !== "numbers"))) {
          document.completeness = "partial";
        }
        currentList.items.push({
          id: publicBlockId(block.id), text: await text(payload.rich_text, payload.color),
          checked: block.type === "to_do" ? block.to_do.checked : null,
          children: await children(block, depth),
        });
      } else {
        currentList = null;
        currentListType = null;
        output.push(...await convertBlock(block, depth));
      }
    }
    return output;
  }

  async function convertBlock(block: BlockObjectResponse, depth: number): Promise<ContentBlock[]> {
    const id = publicBlockId(block.id);
    switch (block.type) {
      case "paragraph": return [{ id, type: "paragraph", text: await text(block.paragraph.rich_text, block.paragraph.color) }, ...omittedChildren(block)];
      case "heading_1": case "heading_2": case "heading_3": case "heading_4": {
        const payload = block.type === "heading_1" ? block.heading_1
          : block.type === "heading_2" ? block.heading_2
            : block.type === "heading_3" ? block.heading_3 : block.heading_4;
        const level = block.type === "heading_1" ? 1 : block.type === "heading_2" ? 2 : 3;
        if (block.type === "heading_4") document.completeness = "partial";
        const title = await text(payload.rich_text, payload.color);
        document.toc.push({ id, title: title.map((run) => run.text).join(""), level });
        const heading: ContentBlock = { id, type: "heading", level, text: title };
        if (payload.is_toggleable) return [heading, {
          id: `${id}-content`, type: "toggle", title: [{ text: "Details" }], children: await children(block, depth),
        }];
        return [heading, ...omittedChildren(block)];
      }
      case "quote": return [{ id, type: "quote", text: await text(block.quote.rich_text, block.quote.color) }, ...omittedChildren(block)];
      case "callout": return [{
        id, type: "callout",
        tone: textColor(block.callout.color) === "warning" ? "warning" : textColor(block.callout.color) === "accent" ? "info" : "default",
        icon: block.callout.icon?.type === "emoji" ? block.callout.icon.emoji : null,
        text: await text(block.callout.rich_text, block.callout.color), children: await children(block, depth),
      }];
      case "toggle": return [{ id, type: "toggle", title: await text(block.toggle.rich_text, block.toggle.color), children: await children(block, depth) }];
      case "code": return [{ id, type: "code", language: block.code.language,
        code: (await text(block.code.rich_text)).map((run) => run.text).join(""), caption: await text(block.code.caption) }, ...omittedChildren(block)];
      case "image": {
        const caption = await text(block.image.caption);
        const alt = caption.map((run) => run.text).join("");
        const rawUrl = block.image.type === "file" ? block.image.file.url : block.image.external.url;
        const url = context.canonicalImageUrls ? canonicalImageUrl(rawUrl) : rawUrl;
        const image = url && safeHttpUrl(url) ? await context.registerImage({
          ownerPageId, blockId: normalizeId(block.id), alt, url,
          ...(context.canonicalImageUrls && (block.parent.type === "page_id" || block.parent.type === "block_id")
            ? { blockParentId: normalizeId(block.parent.type === "page_id" ? block.parent.page_id : block.parent.block_id) } : {}),
          ...(block.image.type === "file" ? { expiryTime: block.image.file.expiry_time } : {}),
        }) : null;
        if (!image || !safeAppPath(image.src)) return [unsupported(block.id, "Image unavailable")];
        return [{ id, type: "image", image: {
          id: image.id, src: image.src, alt: safeText(image.alt), width: image.width, height: image.height,
        }, caption }, ...omittedChildren(block)];
      }
      case "divider": return [{ id, type: "divider" }, ...omittedChildren(block)];
      case "table": {
        if (depth + 1 > maxDepth) return [unsupported(block.id, "Content nesting limit reached")];
        const rows: TextRun[][][] = [];
        const omitted: ContentBlock[] = [];
        for (const row of await client.listBlocks(normalizeId(block.id))) {
          if (row.in_trash || row.archived) continue;
          const failure = claim(row, normalizeId(block.id));
          if (failure) {
            omitted.push(failure);
            if (count >= maxBlocks) break;
          } else if (row.type !== "table_row") {
            omitted.push(unsupported(row.id, "Unsupported table row"));
          } else {
            rows.push(await Promise.all(row.table_row.cells.map((cell) => text(cell))));
            omitted.push(...omittedChildren(row));
          }
        }
        return [{ id, type: "table", hasColumnHeader: block.table.has_column_header,
          hasRowHeader: block.table.has_row_header, rows }, ...omitted];
      }
      case "column_list": {
        if (depth + 1 > maxDepth) return [unsupported(block.id, "Content nesting limit reached")];
        const columns: Extract<ContentBlock, { type: "columns" }>["columns"] = [];
        for (const column of await client.listBlocks(normalizeId(block.id))) {
          if (column.in_trash || column.archived) continue;
          const failure = claim(column, normalizeId(block.id));
          if (failure) {
            columns.push({ ratio: null, blocks: [failure] });
            if (count >= maxBlocks) break;
          } else if (column.type !== "column") {
            columns.push({ ratio: null, blocks: [unsupported(column.id, "Unsupported column")] });
          } else {
            const ratio = column.column.width_ratio;
            columns.push({ ratio: ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? ratio : null,
              blocks: await children(column, depth + 1) });
          }
        }
        return [{ id, type: "columns", columns }];
      }
      case "video": {
        // Uploaded videos use temporary/private file URLs and require a separate media protocol.
        if (!context.externalVideos || block.video.type !== "external") return [unsupported(block.id, "Unsupported Notion block")];
        const link = await resolveNotionTextLink(block.video.external.url, scopedContext);
        if (link.kind === "unavailable") return [unsupported(block.id, "Link unavailable")];
        const caption = (await text(block.video.caption)).map(run => run.text).join("");
        if (link.kind === "internal") return [{ id, type: "child-page", title: caption || "Page", target: { title: caption || "Page", href: link.href } }, ...omittedChildren(block)];
        return [{ id, type: "embed", title: caption || `视频 · ${new URL(link.url).hostname.replace(/^www\./, "")}`, url: link.url, display: "link" }, ...omittedChildren(block)];
      }
      case "bookmark": case "embed": {
        const payload = block.type === "bookmark" ? block.bookmark : block.embed;
        const link = await resolveNotionTextLink(payload.url, scopedContext);
        const caption = (await text(payload.caption)).map((run) => run.text).join("");
        if (link.kind === "unavailable") return [unsupported(block.id, "Link unavailable")];
        if (link.kind === "internal") return [{ id, type: "child-page", title: caption || "Page", target: { title: caption || "Page", href: link.href } }];
        const title = caption || new URL(link.url).hostname;
        return [block.type === "bookmark"
          ? { id, type: "bookmark", title, url: link.url, description: null }
          : { id, type: "embed", title, url: link.url, display: "link" }, ...omittedChildren(block)];
      }
      case "child_page": {
        const target = await resolvedPage(block.id, scopedContext);
        return [{ id, type: "child-page", title: target?.title ?? "Unavailable page", target }];
      }
      case "child_database": {
        // Only a verified course database is represented by the existing directory.
        // Do not inline rows, infer new publication scope or traverse children here.
        if (await context.isCourseDatabaseRepresented?.(normalizeId(block.id))) return [];
        return [unsupported(block.id, "Unsupported Notion block")];
      }
      case "link_to_page": {
        const target = block.link_to_page.type === "page_id"
          ? await resolvedPage(block.link_to_page.page_id, scopedContext) : null;
        return [{ id, type: "child-page", title: target?.title ?? "Unavailable page", target }, ...omittedChildren(block)];
      }
      case "table_of_contents": return [{ id, type: "table-of-contents" }, ...omittedChildren(block)];
      case "equation": return [{ id, type: "equation", expression: safeText(block.equation.expression) }, ...omittedChildren(block)];
      case "synced_block": return block.synced_block.synced_from
        ? [unsupported(block.id, "Referenced synced content is not published")]
        : await children(block, depth);
      // Child databases and unfamiliar types are never crawled automatically.
      default: return [unsupported(block.id, "Unsupported Notion block")];
    }
  }

  document.blocks = await convertChildren(ownerPageId, 0);
  return document;
}
