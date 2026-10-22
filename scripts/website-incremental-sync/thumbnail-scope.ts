/** Operator-reviewed limits for one thumbnail collection, not publication or
 * transport authorization. Omission retains each command's original limits. */
export interface ThumbnailScope {
  format: "thumbnail-scope-v1";
  maxBindings: number;
  maxObjects: number;
  maxBytes: number;
}

export function parseThumbnailScope(input: unknown): ThumbnailScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("THUMBNAIL_SCOPE_INVALID");
  const value = input as ThumbnailScope;
  if (Object.keys(value).length !== 4 || value.format !== "thumbnail-scope-v1" ||
      !Number.isSafeInteger(value.maxBindings) || value.maxBindings < 1 || value.maxBindings > 4000 ||
      !Number.isSafeInteger(value.maxObjects) || value.maxObjects < 1 || value.maxObjects > 4000 ||
      !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 128 * 1024 ** 2) {
    throw Error("THUMBNAIL_SCOPE_INVALID");
  }
  return { format: value.format, maxBindings: value.maxBindings, maxObjects: value.maxObjects, maxBytes: value.maxBytes };
}
