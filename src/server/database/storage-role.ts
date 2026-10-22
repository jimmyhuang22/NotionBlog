export type StorageIdentity = "notion" | "social";

/** Server-owned metadata only. A token cannot serve both storage identities. */
export function hasStorageRole(metadata: unknown, role: "reader" | "writer", identity: StorageIdentity = "notion"): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !["notion", "social"].includes(identity)) return false;
  const values = metadata as Record<string, unknown>;
  const claim = identity === "social" ? "notionblog_social_storage_role" : "notionblog_storage_role";
  const other = identity === "social" ? "notionblog_storage_role" : "notionblog_social_storage_role";
  return values[claim] === role && !Object.hasOwn(values, other);
}
