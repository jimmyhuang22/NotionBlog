import type { Album } from "../../contracts/content.ts";
import { rangeLabel } from "./format.ts";

/** A null count means "not computed" and is left out; only a known zero says there are no photos. */
export function albumMeta(album: Album, timeZone: string): string {
  const count = album.photoCount === null ? null : album.photoCount === 0 ? "暂无照片" : `${album.photoCount} 张`;
  return [rangeLabel(album.date, timeZone) ?? "日期未记录", count].filter(Boolean).join(" · ");
}
