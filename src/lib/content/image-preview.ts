import type { ImageAsset } from "../../../contracts/content.ts";

const websiteV2MediaPath = /^\/media\/v2\/a1\.[a-f0-9]{64}$/;
const databaseMediaPath = /^\/media\/(?:(?:(?:v2\/)?a1|social\/s1)\.[a-f0-9]{64}|social\/s2\.(?:publication|collection)\.[a-f0-9]{64}|social\/s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64})$/;

/** Request a qualified preview without changing the original used by readers and lightboxes. */
export function imagePreviewSrc(image: ImageAsset, width: 400 | 800 | 1600): string {
  if (width !== 400 && width !== 800 && width !== 1600) throw new RangeError("Image preview width must be 400, 800 or 1600.");
  // Larger previews belong only to the qualified website v2 path; SQL limits owner kinds and locators.
  if (width === 1600 && !websiteV2MediaPath.test(image.src)) return image.src;
  // Compare the complete match as well: `$` alone also permits a final line break.
  return databaseMediaPath.exec(image.src)?.[0] === image.src ? `${image.src}?thumbnail=${width}` : image.src;
}

export const gameDetailDesktopMedia = "(min-width: 1024px)";

/** New display mappings may provide 1920. The media route falls back to the existing base on earlier mappings. */
export function gameDetailArtwork(image: ImageAsset): { standard: string; desktop: string | null } {
  const desktop = image.delivery?.mode === "display-only" && (image.width ?? 0) > 1600 &&
    websiteV2MediaPath.exec(image.src)?.[0] === image.src ? `${image.src}?thumbnail=1920` : null;
  return { standard: imagePreviewSrc(image, 1600), desktop };
}
