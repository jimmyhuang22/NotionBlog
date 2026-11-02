/** Versioned social covers register both preview tiers; an error is not permission to fetch a larger file. */
export function coverFailureAction(src: string, original: string, retries: number): "retry" | "failed" | "original" {
  if (src === original) return "failed";
  if (/^\/media\/social\/s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(original) &&
      (src === `${original}?thumbnail=400` || src === `${original}?thumbnail=800`)) return retries === 0 ? "retry" : "failed";
  return "original";
}
