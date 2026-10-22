import { CAPITAL_GLYPHS, GLYPH_CAP_HEIGHT } from "./monogram-glyphs.ts";

/** Up to two initials; CJK names use their first character. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map(word => [...word][0]) : [[...(words[0] ?? "")][0]];
  return letters.join("").toUpperCase();
}

export type IconTheme = "light" | "dark";

/** The seal and the mark cut out of it: ink on paper in the light theme, the reverse tones in the dark one. */
export const ICON_COLORS: Readonly<Record<IconTheme, { seal: string; mark: string }>> = {
  light: { seal: "#244a90", mark: "#fbf8f0" },
  dark: { seal: "#94b4ee", mark: "#121418" },
};

/** The icon is drawn in a square of this size. */
export const ICON_BOX = 64;
/** Shown instead of letters when there is no name, or it does not start with A-Z: the pen stroke from the home page. */
export const ICON_STROKE = "M11 37 C 19 25, 26 46, 34 33 S 47 25, 54 35";

const MAX_WIDTH = 50;

/**
 * Places one or two capital letters in the middle of the icon box. Each entry is an outline and the
 * transform that puts it there. Returns null when a letter has no outline, so the caller draws the stroke.
 */
export function sealGlyphs(letters: string): { d: string; transform: string }[] | null {
  const glyphs = [...letters.toUpperCase()].map(letter => CAPITAL_GLYPHS[letter]);
  if (glyphs.length < 1 || glyphs.length > 2 || glyphs.some(glyph => !glyph)) return null;
  // Centre on the drawn shapes rather than the advance widths, whose side bearings differ per letter.
  const last = glyphs.length - 1;
  const left = inkExtent(glyphs[0]![1])[0];
  const right = glyphs.slice(0, last).reduce((sum, glyph) => sum + glyph![0], 0) + inkExtent(glyphs[last]![1])[1];
  // Two letters stand 24 units tall, one alone 28; a wide pair is scaled down to keep its margins.
  const scale = Math.min((glyphs.length === 2 ? 24 : 28) / GLYPH_CAP_HEIGHT, MAX_WIDTH / (right - left));
  const baseline = ICON_BOX / 2 + (GLYPH_CAP_HEIGHT * scale) / 2 + 0.5;
  let x = (ICON_BOX - (right - left) * scale) / 2 - left * scale;
  return glyphs.map(glyph => {
    const placed = { d: glyph![1], transform: `translate(${round(x)} ${round(baseline)}) scale(${scale.toFixed(5)})` };
    x += glyph![0] * scale;
    return placed;
  });
}

/** Leftmost and rightmost x of an outline made of absolute M, L, Q, H, V and Z commands (control points included). */
export function inkExtent(d: string): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [, command, args] of d.matchAll(/([MLQHVZ])([^MLQHVZ]*)/gu)) {
    const numbers = (args!.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
    const xs = command === "H" ? numbers : command === "V" ? [] : numbers.filter((_, index) => index % 2 === 0);
    for (const x of xs) { min = Math.min(min, x); max = Math.max(max, x); }
  }
  return [min, max];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
