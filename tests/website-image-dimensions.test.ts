import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { imageDimensions } from "../scripts/website-sync/image-dimensions.ts";

test("verified raster formats report dimensions without altering their bytes", async () => {
  for (const format of ["png", "jpeg", "webp", "gif", "avif"] as const) {
    const bytes = await sharp({ create: { width: 3, height: 5, channels: 4, background: "#4477aa" } }).toFormat(format).toBuffer();
    const original = Buffer.from(bytes);
    assert.deepEqual(await imageDimensions(bytes), { width: 3, height: 5 }, format);
    assert.deepEqual(bytes, original);
  }
});

test("EXIF orientation gives the browser display size while preserving the original", async () => {
  const bytes = await sharp({ create: { width: 3, height: 5, channels: 3, background: "#4477aa" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const original = Buffer.from(bytes);
  assert.deepEqual(await imageDimensions(bytes), { width: 5, height: 3 });
  assert.deepEqual(bytes, original);
});

test("animated images use frame dimensions rather than vertically stacked frames", async () => {
  const frames = Buffer.alloc(3 * 10 * 4, 255);
  for (let pixel = 3 * 5; pixel < 3 * 10; pixel++) frames[pixel * 4] = 0;
  const bytes = await sharp(frames, { raw: { width: 3, height: 10, channels: 4, pageHeight: 5 } }).gif({ delay: [10, 20], loop: 0 }).toBuffer();
  assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 2);
  assert.deepEqual(await imageDimensions(bytes), { width: 3, height: 5 });
});

test("unsupported and unreadable image headers retain paired unknown dimensions", async () => {
  for (const bytes of [Buffer.from("<svg width='3' height='5'></svg>"), Buffer.from([255, 216, 255, 0]), Buffer.alloc(0)]) {
    assert.deepEqual(await imageDimensions(bytes), { width: null, height: null });
  }
});
