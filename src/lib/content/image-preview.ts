import type { ImageAsset } from "../../../contracts/content.ts";

const databaseMediaPath = /^\/media\/(?:(?:(?:v2\/)?a1|social\/s1)\.[a-f0-9]{64}|social\/s2\.(?:publication|collection)\.[a-f0-9]{64}|social\/s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64})$/;

/** Request a qualified preview without changing the original used by readers and lightboxes. */
export function imagePreviewSrc(image: ImageAsset, width: 400 | 800 | 1600): string {
  if (width !== 400 && width !== 800 && width !== 1600) throw new RangeError("Image preview width must be 400, 800 or 1600.");
  // Larger previews belong only to the qualified website v2 path; SQL limits owner kinds and locators.
  if (width === 1600 && !/^\/media\/v2\/a1\.[a-f0-9]{64}$/.test(image.src)) return image.src;
  // Compare the complete match as well: `$` alone also permits a final line break.
  return databaseMediaPath.exec(image.src)?.[0] === image.src ? `${image.src}?thumbnail=${width}` : image.src;
}
