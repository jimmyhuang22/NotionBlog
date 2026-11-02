/** Qualified v2 routes already handle missing variants at the server. Retrying an
 * HTTP failure as a larger original only adds load to the same failing reader. */
export function coverFailureAction(src: string, original: string, retries: number): "retry" | "failed" | "original" {
  if (src === original) return "failed";
  if (/^\/media\/v2\/a1\.[a-f0-9]{64}$/.exec(original)?.[0] === original &&
      [400, 800, 1600].some(width => src === `${original}?thumbnail=${width}`)) return retries === 0 ? "retry" : "failed";
  if (/^\/media\/social\/s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(original) &&
      (src === `${original}?thumbnail=400` || src === `${original}?thumbnail=800`)) return retries === 0 ? "retry" : "failed";
  return "original";
}
