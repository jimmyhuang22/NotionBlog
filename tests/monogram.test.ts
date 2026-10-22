import test from "node:test";
import assert from "node:assert/strict";
import { ICON_BOX, inkExtent, monogram, sealGlyphs } from "../src/lib/site/monogram.ts";
import { CAPITAL_GLYPHS, GLYPH_CAP_HEIGHT } from "../src/lib/site/monogram-glyphs.ts";

test("initials come from the first two words, or the first character of a single word", () => {
  assert.equal(monogram("Ada Lovelace"), "AL");
  assert.equal(monogram("  grace   brewster hopper "), "GB");
  assert.equal(monogram("Turing"), "T");
  assert.equal(monogram("示例名字"), "示");
  assert.equal(monogram(""), "");
});

/** translate(x y) scale(s) -> numbers. */
function placement(transform: string): { x: number; y: number; scale: number } {
  const [x, y, scale] = [...transform.matchAll(/-?\d+(?:\.\d+)?/gu)].map(match => Number(match[0])) as [number, number, number];
  return { x, y, scale };
}

test("two letters sit centred in the icon box, a single one stands taller", () => {
  const pair = sealGlyphs("AL")!;
  assert.equal(pair.length, 2);
  const [first, second] = pair.map(glyph => placement(glyph.transform)) as [ReturnType<typeof placement>, ReturnType<typeof placement>];
  // The drawn shapes, not the advance widths, are centred: equal margins left of A and right of L.
  const inkLeft = first.x + inkExtent(CAPITAL_GLYPHS.A![1])[0] * first.scale;
  const inkRight = second.x + inkExtent(CAPITAL_GLYPHS.L![1])[1] * second.scale;
  assert.ok(Math.abs(inkLeft - (ICON_BOX - inkRight)) < 0.05);
  assert.ok(Math.abs(second.x - (first.x + CAPITAL_GLYPHS.A![0] * first.scale)) < 0.02);
  // The cap height is centred on the box, half a unit low for optical balance.
  assert.ok(Math.abs(first.y - (ICON_BOX / 2 + (GLYPH_CAP_HEIGHT * first.scale) / 2 + 0.5)) < 0.02);
  const single = placement(sealGlyphs("T")![0]!.transform);
  assert.ok(single.scale > first.scale);
});

test("a wide pair is scaled down to keep its margins, and lower case is accepted", () => {
  for (const letters of ["MW", "WM", "mw"]) {
    const glyphs = sealGlyphs(letters)!;
    const [a, b] = glyphs.map(glyph => placement(glyph.transform)) as [ReturnType<typeof placement>, ReturnType<typeof placement>];
    const [one, two] = [...letters.toUpperCase()] as [string, string];
    const inkLeft = a.x + inkExtent(CAPITAL_GLYPHS[one]![1])[0] * a.scale;
    const inkRight = b.x + inkExtent(CAPITAL_GLYPHS[two]![1])[1] * b.scale;
    assert.ok(inkRight - inkLeft <= 50.05, letters);
    assert.ok(inkLeft >= 6.9 && inkRight <= ICON_BOX - 6.9, letters);
  }
});

test("names that do not start with A-Z get no letters, so the icon falls back to the pen stroke", () => {
  for (const letters of ["", "示", "A示", "ABC", "1A", "É"]) assert.equal(sealGlyphs(letters), null, letters);
  assert.equal(Object.keys(CAPITAL_GLYPHS).join(""), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
});
