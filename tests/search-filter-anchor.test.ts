import assert from "node:assert/strict";
import test from "node:test";
import { searchFilterPatterns, supportsSearchFilterRuntime } from "../src/server/database/search-filter.ts";
import { sanitizePublicText } from "../src/server/notion/public-text.ts";

test("safe anchors retain matches across generated labels and Unicode expansion boundaries", () => {
  const page = new URL("/fictional", "https://" + ["notion", "so"].join("."));
  const image = new URL("https://example.test/image");
  image.searchParams.set(["sig", "nature"].join(""), "fictional");
  const corpus = ["python", "ＰＹＴＨＯＮ", "𝑝𝑦𝑡ℎ𝑜𝑛", "pytho" + page.href,
    "eJava", page.href + "Java", "j" + page.href, "oﬃce", "office", "two words", "no-match",
    "学习课程", "学习 " + image.href, "Java Media words", "x".repeat(128)];
  for (const q of ["python", "eJava", "jNotion", "office", "ffi", "fi", "two words", "no-match", "学习", "Java Media words", "x".repeat(128)]) {
    const probes = searchFilterPatterns(q);
    assert.equal(probes.length, supportsSearchFilterRuntime() ? 1 : 0, q);
    const normalized = q.normalize("NFKC").toLocaleLowerCase();
    let matches = 0;
    for (const raw of corpus) {
      if (!sanitizePublicText(raw).normalize("NFKC").toLocaleLowerCase().includes(normalized)) continue;
      matches++;
      for (const probe of probes) {
        assert(Buffer.byteLength(probe) <= 2048);
        assert(new RegExp(probe, "u").test(raw), `${q}: ${raw}`);
      }
    }
    assert(matches > 0, `The corpus must exercise a true match for ${q}`);
  }
  for (const q of ["Notion page", "Media", "Unavailable page", "a", "n", "m", "!!!", "x".repeat(129)])
    assert.deepEqual(searchFilterPatterns(q), [], q);
});

test("partial Unicode preimages are kept when a long query uses a shorter anchor", () => {
  const queries = ["oﬃce ".repeat(4).trim(), "ＪＡＶＡ 学习课程", "A python program", "s13-no-match-20261027"];
  for (const q of queries) {
    const probes = searchFilterPatterns(q);
    assert.equal(probes.length, supportsSearchFilterRuntime() ? 1 : 0, q);
    for (const raw of [q, q.normalize("NFKC"), q.toLocaleUpperCase()])
      for (const probe of probes) assert(new RegExp(probe, "u").test(raw), q);
  }
});

test("no anchor loses a match created at either side of a replacement", () => {
  const patterns = new Map<string, string[]>();
  let checked = 0;
  for (const label of ["Notion page", "Media", "Unavailable page"])
    for (const left of ["pytho", "J", "oﬃ", "学习"])
      for (const right of ["n", "Java", "ce", "课程"]) {
        const publicText = (left + label + right).normalize("NFKC").toLocaleLowerCase();
        // '@' stands for a removed reference; the synthetic label is absent in storage.
        const rawText = left + "@" + right;
        for (let start = 0; start < publicText.length; start++)
          for (let end = start + 1; end <= Math.min(publicText.length, start + 16); end++) {
            const q = publicText.slice(start, end);
            if (!q.trim() || q !== q.trim()) continue;
            if (!patterns.has(q)) patterns.set(q, searchFilterPatterns(q));
            for (const pattern of patterns.get(q)!) {
              checked++;
              assert(new RegExp(pattern, "u").test(rawText), `${left}/${label}/${right}: ${q}`);
            }
          }
      }
  if (supportsSearchFilterRuntime()) assert(checked > 100, "Exercise real filters, not only fallback");
});
