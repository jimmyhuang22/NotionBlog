import { createHash } from "node:crypto";
import sharp from "sharp";
import { GameSyncError } from "./model.ts";

const maxIconBytes = 256 * 1024;
const mimeTypes = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

export type CollectedTrophyIcon = { id: string; bytes: string; type: string; width: number; height: number };

/** Preserve original raster bytes within the configured budget and provider URL policy. */
export function createTrophyIconCollector(provider: "psn" | "steam", maxBytes: number,
  budgetError: string, allow: (url: URL) => boolean, request = fetch) {
  let downloaded = 0;
  return async (input: string, setId: string, trophyId: number | string): Promise<CollectedTrophyIcon | null> => {
    if (downloaded >= maxBytes) throw new GameSyncError(budgetError);
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || !allow(url) || url.port || url.username || url.password) return null;
      const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxIconBytes) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          downloaded += value.byteLength;
          if (downloaded >= maxBytes) throw new GameSyncError(budgetError);
          if (size > maxIconBytes) return null;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks, size);
      const image = sharp(bytes, { failOn: "warning", limitInputPixels: 1024 * 1024 });
      const { format, width, height, pages } = await image.metadata();
      if (!format || !Object.hasOwn(mimeTypes, format) || !width || !height || width > 1024 || height > 1024 || (pages ?? 1) !== 1)
        return null;
      await image.raw().toBuffer();
      const hash = createHash("sha256").update(`${setId}:${trophyId}:`).update(bytes).digest("hex");
      return { id: `${provider}-trophy-${hash}`, bytes: bytes.toString("base64"), type: mimeTypes[format as keyof typeof mimeTypes], width, height };
    } catch (error) {
      if (error instanceof GameSyncError) throw error;
      return null;
    }
  };
}
