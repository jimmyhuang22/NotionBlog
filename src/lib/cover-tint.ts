/**
 * A deep colour taken from a cover, for the ground of the games page's stage (乙, 2026-11-24): the average of the
 * picture's mid tones (near-black and near-white pixels say little about it), scaled down so light text on it stays
 * readable. RGBA bytes in, "r g b" out for `rgb(var(--tint))`; null when the picture has no usable tones.
 */
export function coverTint(pixels: ArrayLike<number>): string | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue;
    const light = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
    if (light < 18 || light > 238) continue;
    r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!; n++;
  }
  if (!n) return null;
  const average = [r / n, g / n, b / n];
  const scale = 63 / Math.max(...average, 1);
  return average.map(value => Math.round(Math.min(90, value * scale))).join(" ");
}
