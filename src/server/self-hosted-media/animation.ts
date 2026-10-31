import { displayUnavailable, type DisplayFile } from "./manifest.ts";

/** Bounded RIFF inspection only. The reader never decodes pixels or opens a URL. */
export function verifyDisplayAnimation(file: DisplayFile, b: Buffer): void {
  if (b.length > 4 * 1024 * 1024) displayUnavailable();
  let canvas: [number, number] | undefined, animation = false, frames = 0, totalPixels = 0;
  function image(start: number, end: number, width: number, height: number) {
    let found = false;
    for (let p = start; p < end;) {
      if (p + 8 > end) displayUnavailable();
      const tag = b.toString("ascii", p, p + 4), n = b.readUInt32LE(p + 4), q = p + 8;
      if (q + n + n % 2 > end) displayUnavailable();
      // The reviewed animation recipe is lossless and emits a single VP8L per frame.
      if (tag !== "VP8L" || found || n < 5 || b[q] !== 0x2f) displayUnavailable();
      const bits = b.readUInt32LE(q + 1);
      if (bits >>> 29 || (bits & 0x3fff) + 1 !== width || ((bits >>> 14) & 0x3fff) + 1 !== height) displayUnavailable();
      found = true; p = q + n + n % 2;
    }
    if (!found) displayUnavailable();
  }
  for (let p = 12; p < b.length;) {
    if (p + 8 > b.length) displayUnavailable();
    const tag = b.toString("ascii", p, p + 4), n = b.readUInt32LE(p + 4), q = p + 8;
    if (q + n + n % 2 > b.length) displayUnavailable();
    if (tag === "VP8X") {
      if (p !== 12 || canvas || n !== 10 || !(b[q] & 2) || (b[q] & ~0x12) || b[q + 1] || b[q + 2] || b[q + 3]) displayUnavailable();
      canvas = [b.readUIntLE(q + 4, 3) + 1, b.readUIntLE(q + 7, 3) + 1];
    } else if (tag === "ANIM") {
      if (!canvas || animation || frames || n !== 6) displayUnavailable();
      animation = true;
    } else if (tag === "ANMF") {
      if (!canvas || !animation || n < 16 || b[q + 15] & ~3) displayUnavailable();
      const x = b.readUIntLE(q, 3) * 2, y = b.readUIntLE(q + 3, 3) * 2;
      const width = b.readUIntLE(q + 6, 3) + 1, height = b.readUIntLE(q + 9, 3) + 1;
      if (x + width > canvas[0] || y + height > canvas[1] || !b.readUIntLE(q + 12, 3)) displayUnavailable();
      image(q + 16, q + n, width, height);
      frames++; totalPixels += width * height;
      if (frames > 300 || totalPixels > 40_000_000 || canvas[0] * canvas[1] * frames > 40_000_000) displayUnavailable();
    } else displayUnavailable();
    p = q + n + n % 2;
  }
  if (!animation || !canvas || canvas[0] !== file.width || canvas[1] !== file.height || frames < 2) displayUnavailable();
}
