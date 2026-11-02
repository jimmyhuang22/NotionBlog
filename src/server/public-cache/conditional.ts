/** GET/HEAD weak comparison, bounded before parsing an untrusted request header. */
export function matchesIfNoneMatch(condition: string | null | undefined, etag: string): boolean {
  return condition != null && condition.length <= 8192 &&
    (condition.trim() === "*" || (condition.match(/(?:W\/)?"[^"\r\n]*"/g) ?? []).some(v => v.replace(/^W\//, "") === etag));
}
