import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImageAsset } from "../../../contracts/content.ts";
import type { RegisterBlockImageInput } from "./blocks.ts";
import { normalizeId } from "./config.ts";
import { getProperty } from "./properties.ts";
import { isNotionPageHost } from "./public-text.ts";
import type { NotionRepository } from "./repository.ts";
import type { NotionReadClient } from "./types.ts";
import { sourceFingerprint } from "../media/notion-source.ts";

/** property is an opaque keyed tag, never a source property name or ID. */
interface AssetLocation { page: string; block?: string; property?: string }
export function safeMediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    return url.toString();
  } catch { return null; }
}

/** The source URL is deliberately absent from the signed stable asset location. */
export function createMediaSigner(secret: string) {
  if (!secret) throw new Error("Media signing configuration is missing.");
  const sign = (payload: string) => createHmac("sha256", secret).update(`notion-media-v1:${payload}`).digest("base64url");
  const propertyTag = (property: string) => createHmac("sha256", secret).update(`notion-media-property-v1:${property}`).digest("base64url");
  return {
    /** Used only on the server to compare an asset with the current mapping. */
    propertyTag,
    async registerImage(input: RegisterBlockImageInput): Promise<ImageAsset | null> {
      const url = safeMediaUrl(input.url);
      if (!url || (input.expiryTime === undefined && isNotionPageHost(new URL(url).hostname)) ||
        (input.blockId && input.property) || (input.property !== undefined && (!input.property || input.property.length > 256))) return null;
      const location: AssetLocation = { page: normalizeId(input.ownerPageId) };
      if (input.blockId) location.block = normalizeId(input.blockId);
      if (input.property) location.property = propertyTag(input.property);
      const payload = Buffer.from(JSON.stringify(location)).toString("base64url");
      const id = `m1.${payload}.${sign(payload)}`;
      return { id, src: `/media/${id}`, alt: input.alt, width: input.width ?? null, height: input.height ?? null };
    },
    decode(id: string): AssetLocation | null {
      if (id.length > 2048) return null;
      const match = /^m1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(id);
      if (!match) return null;
      const expected = Buffer.from(sign(match[1]));
      const actual = Buffer.from(match[2]);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      try {
        const location = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as AssetLocation;
        if (!location || typeof location.page !== "string" || normalizeId(location.page) !== location.page) return null;
        if (location.block !== undefined && (typeof location.block !== "string" || normalizeId(location.block) !== location.block)) return null;
        if (location.property !== undefined && (typeof location.property !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(location.property))) return null;
        if (location.block && location.property) return null;
        return location;
      } catch { return null; }
    },
  };
}

export async function resolveSignedMediaSource(id: string, repository: NotionRepository, client: NotionReadClient, secret: string): Promise<{ url: string; sourceFingerprint: string } | null> {
  const signer = createMediaSigner(secret);
  const location = signer.decode(id);
  if (!location) return null;
  const owner = repository.resolveMediaOwner ? await repository.resolveMediaOwner(location.page) : await repository.resolvePublicPage(location.page);
  if (!owner || normalizeId(owner.page.id) !== location.page || owner.page.archived || owner.page.in_trash || owner.page.is_archived) return null;
  let file = owner.page.cover;
  if (location.block) {
    const block = await client.getBlock(location.block);
    if (!block || normalizeId(block.id) !== location.block || block.type !== "image" || block.archived || block.in_trash) return null;
    let parent = block.parent;
    const seen = new Set<string>([location.block]);
    for (let depth = 0; parent.type === "block_id" && depth < 24; depth++) {
      const parentId = normalizeId(parent.block_id);
      if (seen.has(parentId)) return null;
      seen.add(parentId);
      const ancestor = await client.getBlock(parentId);
      if (!ancestor || normalizeId(ancestor.id) !== parentId || ancestor.archived || ancestor.in_trash || (ancestor.type === "synced_block" && ancestor.synced_block.synced_from)) return null;
      parent = ancestor.parent;
    }
    if (parent.type !== "page_id" || normalizeId(parent.page_id) !== location.page) return null;
    file = block.image;
  } else if (location.property) {
    const mapping = owner.source.cover.property;
    if (owner.source.cover.strategy !== "files-property" || !mapping || signer.propertyTag(mapping) !== location.property) return null;
    const property = getProperty(owner.page, mapping);
    file = property?.type === "files" ? property.files[0] ?? null : null;
  } else if (owner.source.cover.strategy !== "native-page-cover") return null;
  if (!file || (file.type !== "external" && file.type !== "file")) return null;
  if (file.type === "file" && (!Number.isFinite(Date.parse(file.file.expiry_time)) || Date.parse(file.file.expiry_time) <= Date.now() + 5000)) return null;
  const url = safeMediaUrl(file.type === "file" ? file.file.url : file.external.url);
  if (url && file.type === "external" && isNotionPageHost(new URL(url).hostname)) return null;
  return url ? { url, sourceFingerprint: sourceFingerprint(url, file.type === "file") } : null;
}

export async function resolveMediaUrl(id: string, repository: NotionRepository, client: NotionReadClient, secret: string): Promise<string | null> {
  return (await resolveSignedMediaSource(id, repository, client, secret))?.url ?? null;
}
