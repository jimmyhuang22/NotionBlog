import type { PageObjectResponse } from "@notionhq/client";
import { sourceFingerprint, type MediaSourceBinding } from "../media/notion-source.ts";
import { normalizeId } from "./config.ts";
import { safeMediaUrl } from "./media.ts";
import { getProperty } from "./properties.ts";
import { isNotionPageHost } from "./public-text.ts";
import type { NotionReadClient } from "./types.ts";

/** Minimal private owner projection shared by frozen v1 and website v2. */
export interface NotionMediaSourceOwner {
  page: PageObjectResponse;
  source: { cover: { strategy: "none" | "native-page-cover" | "files-property"; property?: string } };
}
export interface NotionMediaSourceRepository {
  resolveMediaOwner?(id: string): Promise<NotionMediaSourceOwner | null>;
  resolvePublicPage?(id: string): Promise<NotionMediaSourceOwner | null>;
}

function idOrNull(value: string): string | null {
  try { return normalizeId(value); } catch { return null; }
}

/**
 * Re-read the source locator after its owner passes current publication checks.
 * The caller must separately compare the returned fingerprint with its binding
 * and re-check database eligibility before issuing a response. No bytes or
 * publication result are cached, and an unavailable source never falls back.
 */
export async function resolveNotionMediaSource(
  binding: Pick<MediaSourceBinding, "ownerPageId" | "locator">,
  repository: NotionMediaSourceRepository,
  client: NotionReadClient,
): Promise<{ url: string; sourceFingerprint: string } | null> {
  const ownerId = idOrNull(binding.ownerPageId);
  if (!ownerId) return null;
  const owner = repository.resolveMediaOwner
    ? await repository.resolveMediaOwner(ownerId)
    : repository.resolvePublicPage ? await repository.resolvePublicPage(ownerId) : null;
  if (!owner || idOrNull(owner.page.id) !== ownerId || owner.page.archived || owner.page.in_trash || owner.page.is_archived) return null;

  let file: PageObjectResponse["cover"] = null;
  const locator = binding.locator;
  if (locator.kind === "block") {
    const blockId = idOrNull(locator.id);
    if (!blockId) return null;
    const block = await client.getBlock(blockId);
    if (!block || idOrNull(block.id) !== blockId || block.type !== "image" || block.archived || block.in_trash) return null;
    let parent = block.parent;
    const seen = new Set<string>([blockId]);
    for (let depth = 0; parent.type === "block_id" && depth < 24; depth++) {
      const parentId = idOrNull(parent.block_id);
      if (!parentId || seen.has(parentId)) return null;
      seen.add(parentId);
      const ancestor = await client.getBlock(parentId);
      if (!ancestor || idOrNull(ancestor.id) !== parentId || ancestor.archived || ancestor.in_trash ||
          (ancestor.type === "synced_block" && ancestor.synced_block.synced_from)) return null;
      parent = ancestor.parent;
    }
    if (parent.type !== "page_id" || idOrNull(parent.page_id) !== ownerId) return null;
    file = block.image;
  } else if (locator.kind === "property") {
    const mapping = owner.source.cover.property;
    if (owner.source.cover.strategy !== "files-property" || !mapping || mapping !== locator.name) return null;
    const property = getProperty(owner.page, mapping);
    file = property?.type === "files" ? property.files[0] ?? null : null;
  } else if (locator.kind === "cover") {
    if (owner.source.cover.strategy !== "native-page-cover") return null;
    file = owner.page.cover;
  } else return null;

  if (!file || (file.type !== "file" && file.type !== "external")) return null;
  if (file.type === "file") {
    const expiry = Date.parse(file.file.expiry_time);
    if (!Number.isFinite(expiry) || expiry <= Date.now() + 5000) return null;
  }
  const url = safeMediaUrl(file.type === "file" ? file.file.url : file.external.url);
  if (!url || new URL(url).protocol !== "https:" ||
      (file.type === "external" && isNotionPageHost(new URL(url).hostname))) return null;
  return { url, sourceFingerprint: sourceFingerprint(url, file.type === "file") };
}
