import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import sharp from "sharp";
import { generateThumbnails } from "../scripts/media-thumbnails/encode.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function decode(bytes: Uint8Array) {
  return sharp(bytes).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
}
function rawPixels(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const values = pixel(x, y);
    for (let channel = 0; channel < 4; channel++) data[(y * width + x) * 4 + channel] = values[channel];
  }
  return data;
}
function png(data: Buffer, width: number, height: number) {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, "ascii");
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.byteLength - 4)), result.byteLength - 4);
  return result;
}
function animatedPng(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0);
  const control = (sequence: number) => {
    const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence, 0); bytes.writeUInt32BE(1, 4); bytes.writeUInt32BE(1, 8); bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes;
  };
  const second = Buffer.concat([Buffer.from([0, 0, 0, 2]), deflateSync(Buffer.from([0, 0, 0, 255, 255]))]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("acTL", animation),
    chunk("fcTL", control(0)), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("fcTL", control(1)), chunk("fdAT", second), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("real alpha gradients survive thumbnail encoding, including transparent colors", async () => {
  const width = 960, height = 480;
  const data = rawPixels(width, height, (x, y) => [x % 256, y % 256, (x + y) % 256, x < 60 ? 0 : x > 900 ? 255 : Math.round((x - 60) * 255 / 840)]);
  const original = await png(data, width, height);
  const before = sha(original);
  const outputs = await generateThumbnails(original);
  assert.deepEqual(outputs.map(output => [output.widthCap, output.width, output.height]), [[400, 400, 200], [800, 800, 400]]);
  for (const output of outputs) {
    const reference = await sharp(data, { raw: { width, height, channels: 4 } })
      .resize({ width: output.widthCap, kernel: "lanczos3" }).raw().toBuffer();
    const result = await decode(output.bytes);
    assert.equal(result.info.channels, 4);
    for (let index = 3; index < reference.length; index += 4) assert.equal(result.data[index], reference[index]);
    assert.equal(output.sha256, sha(output.bytes));
    assert.equal(output.byteSize, output.bytes.byteLength);
    assert.equal(output.mime, "image/webp");
    assert.equal(output.profile, "webp-v1");
  }
  assert.equal(sha(original), before);
});

test("small inputs retain dimensions and identical cap outputs without sharing mutable byte views", async () => {
  const original = await png(rawPixels(31, 19, (x, y) => [x * 7, y * 11, 80, 255]), 31, 19);
  const outputs = await generateThumbnails(original);
  assert.deepEqual(outputs.map(output => [output.width, output.height]), [[31, 19], [31, 19]]);
  assert.equal(outputs[0].sha256, outputs[1].sha256);
  assert.notEqual(outputs[0].bytes.buffer, outputs[1].bytes.buffer);
  const untouched = outputs[1].bytes[0];
  outputs[0].bytes[0] ^= 255;
  assert.equal(outputs[1].bytes[0], untouched);
});

test("1600 requests skip originals no wider than the requested preview", async () => {
  const original = await sharp({ create: { width: 1600, height: 32, channels: 3, background: "#557799" } }).png().toBuffer();
  assert.deepEqual(await generateThumbnails(original, { widthCaps: [1600] }), []);
});

test("flat textlike pixels select the smaller lossless file and decode exactly", async () => {
  const width = 320, height = 160;
  const data = rawPixels(width, height, (x, y) => {
    const ink = y > 20 && y < 140 && (y % 18 < 3 || (x % 24 < 3 && y % 18 < 12));
    return ink ? [22, 39, 58, 255] : [250, 247, 240, 255];
  });
  const original = await png(data, width, height);
  const raw = { width, height, channels: 4 as const };
  const lossy = await sharp(data, { raw }).webp({ quality: 85, alphaQuality: 100, exact: true, effort: 6 }).toBuffer();
  const lossless = await sharp(data, { raw }).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
  assert.ok(lossless.byteLength < lossy.byteLength, "fixture must exercise the lossless choice");
  const outputs = await generateThumbnails(original);
  for (const output of outputs) {
    assert.equal(output.sha256, sha(lossless));
    assert.deepEqual((await decode(output.bytes)).data, data);
  }
});

test("EXIF orientation is applied before width caps and metadata is stripped", async () => {
  const original = await sharp({ create: { width: 240, height: 960, channels: 3, background: "#2e658f" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const outputs = await generateThumbnails(original);
  assert.deepEqual(outputs.map(output => [output.width, output.height]), [[400, 100], [800, 200]]);
  for (const output of outputs) {
    const metadata = await sharp(output.bytes).metadata();
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
  }
});

test("animated GIF, WebP, APNG and multipage TIFF return no thumbnails rather than flattening", async () => {
  const width = 8, pageHeight = 8, height = 16;
  const data = rawPixels(width, height, (_x, y) => y < pageHeight ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  const raw = { width, height, channels: 4 as const, pageHeight };
  const gif = await sharp(data, { raw }).gif({ delay: [100, 100] }).toBuffer();
  const webp = await sharp(data, { raw }).webp({ lossless: true, delay: [100, 100] }).toBuffer();
  const tiff = await sharp(data, { raw }).tiff({ compression: "deflate" }).toBuffer();
  for (const input of [gif, webp, tiff]) {
    assert.equal((await sharp(input, { animated: true }).metadata()).pages, 2);
    assert.deepEqual(await generateThumbnails(input), []);
  }
  const apng = animatedPng();
  assert.equal((await sharp(apng).metadata()).format, "png");
  assert.deepEqual(await generateThumbnails(apng), []);
});

test("16-bit input is explicitly skipped without reducing its depth", async () => {
  const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#556677" } })
    .toColourspace("rgb16").png().toBuffer();
  assert.equal((await sharp(input).metadata()).depth, "ushort");
  const before = sha(input);
  assert.deepEqual(await generateThumbnails(input), []);
  assert.equal(sha(input), before);
});

test("empty, malformed, truncated, active-format and oversized inputs reject", async () => {
  const valid = await png(rawPixels(10, 10, () => [20, 30, 40, 255]), 10, 10);
  for (const input of [new Uint8Array(), Buffer.from("not an image"), valid.subarray(0, 40), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')]) {
    await assert.rejects(generateThumbnails(input));
  }
  await assert.rejects(generateThumbnails(new Uint8Array(20 * 1024 * 1024 + 1)), /byte limit/);
  await assert.rejects(generateThumbnails(valid, { maxBytes: valid.byteLength - 1 }), /byte limit/);
  await assert.rejects(generateThumbnails(valid, { maxPixels: 99 }), /pixel limit/iu);
  for (const options of [{ maxBytes: 20 * 1024 * 1024 + 1 }, { maxPixels: 40_000_001 }, { timeoutSeconds: 61 }, { maxPixels: 0 }]) {
    await assert.rejects(generateThumbnails(valid, options), /Invalid thumbnail/);
  }
});

test("pixel bombs reject from bounded metadata before attempting a full decode", async () => {
  const original = await png(rawPixels(1, 1, () => [1, 2, 3, 255]), 1, 1);
  const huge = Buffer.from(original);
  huge.writeUInt32BE(10_000, 16); huge.writeUInt32BE(10_000, 20);
  huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
  await assert.rejects(generateThumbnails(huge), /pixel limit/iu);
});

test("repeated encoding is deterministic for the same source and width caps", async () => {
  const original = await png(rawPixels(840, 240, (x, y) => [x % 256, (x * y) % 256, y % 256, 255]), 840, 240);
  const first = await generateThumbnails(original);
  const second = await generateThumbnails(original);
  assert.deepEqual(first.map(({ bytes: _bytes, ...description }) => description), second.map(({ bytes: _bytes, ...description }) => description));
  for (let index = 0; index < first.length; index++) assert.deepEqual(first[index].bytes, second[index].bytes);
  assert.deepEqual(first.map(output => output.widthCap), [400, 800]);
});

test("selecting a single cap preserves the same recipe bytes and produces no unused output", async()=>{
  const original=await png(rawPixels(840,40,(x,y)=>[x%256,y%256,(x*y)%256,255]),840,40);
  const both=await generateThumbnails(original);
  for(const widthCap of [400,800] as const) {
    const selected=await generateThumbnails(original,{widthCaps:[widthCap]});
    assert.equal(selected.length,1);assert.deepEqual(selected[0],both.find(output=>output.widthCap===widthCap));
  }
  for(const widthCaps of [[],[401],[400,400]]) {
    await assert.rejects(generateThumbnails(original,{widthCaps:widthCaps as (400|800)[]}),/Invalid thumbnail width caps/);
  }
});


test("explicit 1600 cap preserves defaults and returns no enlarged small-original variant", async () => {
  const original = await sharp({ create: { width: 1672, height: 941, channels: 3, background: "#a4c1e2" } }).png().toBuffer();
  const outputs = await generateThumbnails(original, { widthCaps: [1600] });
  assert.deepEqual(outputs.map(x => [x.widthCap, x.width, x.height]), [[1600, 1600, 900]]);
  assert.equal((await sharp(outputs[0].bytes).metadata()).width, 1600);
  assert.deepEqual((await generateThumbnails(original)).map(x => x.widthCap), [400, 800]);
  const small = await sharp(original).resize({ width: 1000 }).png().toBuffer();
  assert.deepEqual(await generateThumbnails(small, { widthCaps: [1600] }), []);
  assert.deepEqual((await generateThumbnails(small, { widthCaps: [800, 1600] })).map(x => x.widthCap), [800]);
});
