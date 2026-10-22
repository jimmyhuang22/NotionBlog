import { writeFile } from "node:fs/promises";

// Public Unicode data only. Match the application's normalization and locale.
const alphabet = /^[a-z0-9\u4e00-\u9fff]+$/u;
const variants: Record<string, string[]> = {};
for (let cp = 0x80; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff || cp >= 0x4e00 && cp <= 0x9fff) continue;
  const source = String.fromCodePoint(cp), normalized = source.normalize("NFKC").toLocaleLowerCase("en-US");
  const segments = new Set<string>();
  for (let start = 0; start < normalized.length; start++)
    for (let end = start + 1; end <= normalized.length; end++)
      if (alphabet.test(normalized.slice(start, end))) segments.add(normalized.slice(start, end));
  for (const segment of segments) (variants[segment] ??= []).push(source);
}
const ordered = Object.fromEntries(Object.entries(variants).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
await writeFile(new URL("../database/search-filter-variants.json", import.meta.url), JSON.stringify({
  unicode: process.versions.unicode, locale: "en-US", variants: ordered,
}, null, 2) + "\n");
