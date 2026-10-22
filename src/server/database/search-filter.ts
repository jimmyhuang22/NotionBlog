import data from "../../../database/search-filter-variants.json" with { type: "json" };

const variants: Record<string, string[]> = data.variants;
const alphabet = /^[a-z0-9\u4e00-\u9fff]+$/u;
const locale = new Intl.Collator().resolvedOptions().locale;
// Text can be created by public-text sanitization and unavailable-reference scrubbing.
const replacements = ["Notion page", "Media", "Unavailable page"].map(s => s.normalize("NFKC").toLocaleLowerCase("en-US"));
const maxPatternBytes = 2048;

export function supportsSearchFilterRuntime(unicode = process.versions.unicode, currentLocale = locale): boolean {
  return unicode === data.unicode && currentLocale === data.locale;
}

/** A necessary condition only; the original authorized projection and TS matcher remain authoritative. */
export function searchFilterPatterns(query: string): string[] {
  if (!supportsSearchFilterRuntime()) return [];
  const needle = query.normalize("NFKC").toLocaleLowerCase();
  if (!alphabet.test(needle) || needle.length > 16) return [];
  // A match touching a generated replacement may have no contiguous raw-text preimage.
  for (const label of replacements) {
    if (label.includes(needle) || needle.includes(label)) return [];
    for (let n = 1; n <= Math.min(needle.length, label.length); n++)
      if (needle.startsWith(label.slice(-n)) || needle.endsWith(label.slice(0, n))) return [];
  }
  const sourceClass = (segment: string): string | null => {
    const direct = segment.length === 1 ? segment + (/^[a-z]$/.test(segment) ? segment.toUpperCase() : "") : "";
    const chars = direct + (variants[segment] ?? []).join("");
    return chars ? `[${chars}]` : null;
  };
  const memo = new Map<number, string | null>();
  function suffix(offset: number): string | null {
    if (offset === needle.length) return "";
    if (memo.has(offset)) return memo.get(offset)!;
    const branches: string[] = [];
    for (let end = offset + 1; end <= needle.length; end++) {
      const head = sourceClass(needle.slice(offset, end));
      if (!head) continue;
      const tail = suffix(end);
      // Dropping an alternative could lose a normalization preimage; use the old reader instead.
      if (tail === null || Buffer.byteLength(head + tail) > maxPatternBytes) {
        memo.set(offset, null); return null;
      }
      branches.push(head + tail);
    }
    const pattern = branches.length === 1 ? branches[0] : branches.length ? `(?:${branches.join("|")})` : null;
    const bounded = pattern !== null && Buffer.byteLength(pattern) <= maxPatternBytes ? pattern : null;
    memo.set(offset, bounded); return bounded;
  }
  const pattern = suffix(0);
  return pattern === null ? [] : [pattern];
}
