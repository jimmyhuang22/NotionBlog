import sharp from "sharp";
import { imageMime } from "../notion-sync/download.ts";

const MAX_PIXELS = 100_000_000;

/** Read display dimensions from verified bytes without transforming the original. */
export async function imageDimensions(bytes: Uint8Array): Promise<{ width: number | null; height: number | null }> {
  const unknown = { width: null, height: null };
  if (bytes.byteLength > 20 * 1024 * 1024 || !imageMime(bytes)) return unknown;
  try {
    const metadata = await sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      pages: 1, limitInputPixels: MAX_PIXELS, failOn: "warning",
    }).metadata();
    const { width, height } = metadata.autoOrient;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > Math.floor(MAX_PIXELS / height)) return unknown;
    return { width, height };
  } catch {
    return unknown;
  }
}
