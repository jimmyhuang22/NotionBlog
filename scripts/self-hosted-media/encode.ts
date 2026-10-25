import { createHash } from "node:crypto";
import sharp from "sharp";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_WEBP_DIMENSION = 16_383;
const WIDTH_CAPS = [400, 800, 1600] as const;
const SUPPORTED_WIDTH_CAPS = [400, 800, 1600] as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RASTER_FORMATS = new Set(["jpeg", "png", "webp", "gif", "tiff", "heif"]);

/** Change this recipe version whenever normalization, resizing or encoding changes. */
export function displayEncodingRecipe(): string {
  const versions = Object.fromEntries(Object.entries(sharp.versions).sort(([a], [b]) => a.localeCompare(b)));
  return `display-webp-v1:${createHash("sha256").update(JSON.stringify(versions)).digest("hex")}`;
}

export interface GeneratedDisplayVariant {
  widthCap: 400 | 800 | 1600;
  bytes: Uint8Array;
  mime: "image/webp";
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  profile: "display-webp-v1";
}

export interface DisplayEncodeOptions {
  /** Encode only these caps; omitted generates 400/800 and the mandatory 1600 base. */
  widthCaps?: readonly (400 | 800 | 1600)[];
  /** These bounds may be reduced, but never raised above the hard limits. */
  maxBytes?: number;
  maxPixels?: number;
  /** Native processing time per operation, excluding the libuv queue. */
  timeoutSeconds?: number;
}

function bound(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`Invalid thumbnail ${name} bound`);
  }
  return result;
}

function animatedPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  // libspng may expose only the first APNG frame. Never turn it into a still image.
  for (let offset = 8; offset + 12 <= input.byteLength;) {
    const length = input.readUInt32BE(offset);
    if (length > input.byteLength - offset - 12) break;
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") break;
    offset += length + 12;
  }
  return false;
}

interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

async function checkEncoding(encoded: Buffer, reference: Pixels, lossless: boolean, timeoutSeconds: number): Promise<void> {
  const decoded = await sharp(encoded, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" })
    .timeout({ seconds: timeoutSeconds }).toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== reference.width || decoded.info.height !== reference.height ||
      decoded.info.channels !== 4 || decoded.data.length !== reference.data.length) {
    throw new Error("Thumbnail encoded dimensions do not match the resized image");
  }
  if (lossless && !decoded.data.equals(reference.data)) {
    throw new Error("Lossless thumbnail changed resized RGBA pixels");
  }
  for (let index = 3; index < reference.data.length; index += 4) {
    if (decoded.data[index] !== reference.data[index]) {
      throw new Error("Thumbnail changed resized alpha pixels");
    }
  }
}

/**
 * Independent display recipe: always permits a native-size <=1600 base.
 * The legacy thumbnail encoder and its skip/benefit rules remain unchanged.
 * Animation, multipage images and non-8-bit inputs deliberately return no files;
 * callers must reject an incomplete display batch. Malformed inputs reject.
 * Lossless describes encoding of the resized reference, never the original image.
 */
export async function generateDisplayVariants(
  bytes: Uint8Array,
  options: DisplayEncodeOptions = {},
): Promise<GeneratedDisplayVariant[]> {
  const maxBytes = bound(options.maxBytes, MAX_INPUT_BYTES, MAX_INPUT_BYTES, "byte");
  const maxPixels = bound(options.maxPixels, MAX_INPUT_PIXELS, MAX_INPUT_PIXELS, "pixel");
  const timeoutSeconds = bound(options.timeoutSeconds, 30, 60, "processing time");
  const selected = options.widthCaps ?? WIDTH_CAPS;
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 3 ||
      Array.from(selected).some(width => width !== 400 && width !== 800 && width !== 1600) || new Set(selected).size !== selected.length) {
    throw new Error("Invalid thumbnail width caps");
  }
  const widthCaps = SUPPORTED_WIDTH_CAPS.filter(width => selected.includes(width));
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxBytes) {
    throw new Error("Thumbnail input exceeds the byte limit or is empty");
  }
  // Snapshot the caller's view; asynchronous native processing must not share it.
  const input = Buffer.from(bytes);
  const inputOptions = { failOn: "warning" as const, limitInputPixels: maxPixels };
  const metadata = await sharp(input, { ...inputOptions, animated: true }).metadata();
  const { width, height } = metadata;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      !width || !height || width < 1 || height < 1 || width > Math.floor(maxPixels / height)) {
    throw new Error("Thumbnail input exceeds the pixel limit or has invalid dimensions");
  }
  if ((metadata.pages ?? 1) > 1 || animatedPng(input) ||
      metadata.depth !== "uchar" || (metadata.bitsPerSample ?? 8) > 8) {
    return [];
  }
  if (!RASTER_FORMATS.has(metadata.format) || (metadata.format === "heif" && metadata.compression !== "av1")) {
    throw new Error("Thumbnail input is not a supported static raster image");
  }
  const canonical = await sharp(input, inputOptions).autoOrient().toColourspace("srgb")
    .ensureAlpha().raw({ depth: "uchar" }).timeout({ seconds: timeoutSeconds })
    .toBuffer({ resolveWithObject: true });
  if (canonical.info.channels !== 4) throw new Error("Thumbnail input could not be normalized to RGBA");
  const raw = { width: canonical.info.width, height: canonical.info.height, channels: 4 as const };
  const results: GeneratedDisplayVariant[] = [];
  const completed = new Map<string, { encoded: Buffer; width: number; height: number }>();
  for (const widthCap of widthCaps) {
    const reference = await sharp(canonical.data, { raw, limitInputPixels: maxPixels })
      .resize({ width: widthCap, withoutEnlargement: true, kernel: "lanczos3" })
      .raw({ depth: "uchar" }).timeout({ seconds: timeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    const pixels = { data: reference.data, width: reference.info.width, height: reference.info.height };
    if (pixels.width > MAX_WEBP_DIMENSION || pixels.height > MAX_WEBP_DIMENSION) {
      throw new Error("Thumbnail dimensions exceed the WebP format limit");
    }
    const key = `${pixels.width}x${pixels.height}`;
    let selected = completed.get(key);
    if (!selected) {
      const resizedRaw = { width: pixels.width, height: pixels.height, channels: 4 as const };
      const lossy = await sharp(pixels.data, { raw: resizedRaw, limitInputPixels: maxPixels })
        .webp({ quality: 85, alphaQuality: 100, exact: true, effort: 6 })
        .timeout({ seconds: timeoutSeconds }).toBuffer();
      const lossless = await sharp(pixels.data, { raw: resizedRaw, limitInputPixels: maxPixels })
        .webp({ lossless: true, exact: true, effort: 6 })
        .timeout({ seconds: timeoutSeconds }).toBuffer();
      await checkEncoding(lossy, pixels, false, timeoutSeconds);
      await checkEncoding(lossless, pixels, true, timeoutSeconds);
      // A size tie favors the reference-exact candidate.
      const encoded = lossless.byteLength <= lossy.byteLength ? lossless : lossy;
      selected = { encoded, width: pixels.width, height: pixels.height };
      completed.set(key, selected);
    }
    results.push({
      widthCap,
      bytes: new Uint8Array(selected.encoded),
      mime: "image/webp",
      sha256: createHash("sha256").update(selected.encoded).digest("hex"),
      byteSize: selected.encoded.byteLength,
      width: selected.width,
      height: selected.height,
      profile: "display-webp-v1",
    });
  }
  return results;
}
