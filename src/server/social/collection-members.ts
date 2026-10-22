import { ContentServiceError } from "../../../contracts/repository.ts";

/** Legacy cover fallback when the additive playback extension is disabled. */
export const eligibleCollectionMemberSql = `p.publication->>'platform'='bilibili' AND
  ((c.kind='multi-part' AND p.publication->>'publicationId'=c.collection_id) OR
   (c.kind='season' AND p.publication->>'publishedAt' IS NOT NULL))`;
export const latestCollectionMemberOrderSql = `p.publication->>'publishedAt' DESC NULLS LAST,p.publication->>'id'`;
export function socialCollectionPlaybackEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "disabled") return false;
  if (value === "enabled") return true;
  throw new ContentServiceError("MISCONFIGURED", "Collection playback configuration is invalid.");
}
