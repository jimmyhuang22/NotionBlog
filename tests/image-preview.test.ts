import test from "node:test";
import assert from "node:assert/strict";
import type { ImageAsset } from "../contracts/content.ts";
import { imagePreviewSrc } from "../src/lib/content/image-preview.ts";

const assetId = `a1.${"1a".repeat(32)}`;
function image(src: string): ImageAsset {
  return { id: assetId, src, alt: "A sample image", width: null, height: null };
}

test("database previews preserve the original asset and request only supported widths", () => {
  for (const prefix of ["/media/", "/media/v2/"]) {
    const original = image(`${prefix}${assetId}`);
    for (const width of [400, 800] as const) {
      assert.equal(imagePreviewSrc(original, width), `${original.src}?thumbnail=${width}`);
      assert.equal(original.src, `${prefix}${assetId}`);
    }
  }
});

test("mock, direct Notion tokens, external URLs and noncanonical database URLs stay unchanged", () => {
  const unchanged = [
    "/mock-media/photo.svg",
    "/media/n1.signed-token",
    "/media/v2/n1.signed-token",
    `https://images.example.test/media/${assetId}`,
    `https://site.example.test/media/${assetId}`,
    `//images.example.test/media/${assetId}`,
    `media/${assetId}`,
    `/media/v1/${assetId}`,
    `/media/${assetId}?token=sample`,
    `/media/${assetId}?thumbnail=400`,
    `/media/${assetId}#fragment`,
    `/media/${assetId}/`,
    `/media/${assetId}\n`,
    `/media/${assetId}\r`,
    `/media/${assetId}\r\n`,
    ` /media/${assetId}`,
    `/media/${assetId.slice(0, -1)}`,
    `/media/${assetId}0`,
    `/media/${assetId.toUpperCase()}`,
    `/media/a1.${"g".repeat(64)}`,
    "",
  ];
  for (const src of unchanged) {
    for (const width of [400, 800] as const) assert.equal(imagePreviewSrc(image(src), width), src);
  }
});

test("unsupported preview widths are rejected before constructing a media request", () => {
  for (const width of [0, 200, 600, 1200, NaN, Infinity, "400", undefined]) {
    assert.throws(() => imagePreviewSrc(image(`/media/${assetId}`), width as 400), RangeError);
  }
});


test("course-cover 1600 URLs are constructed only for canonical website v2 assets", () => {
  const source = image(`/media/v2/${assetId}`);
  assert.equal(imagePreviewSrc(source, 1600), `${source.src}?thumbnail=1600`);
  for (const src of [`/media/${assetId}`, `/media/social/s1.${"a".repeat(64)}`, `/media/v2/${assetId}\n`, "/mock-media/photo.svg", "https://images.example.test/photo.png"]) {
    assert.equal(imagePreviewSrc(image(src), 1600), src);
  }
});
