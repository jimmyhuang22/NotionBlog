import { createHash } from "node:crypto";
import { GameSyncError } from "./model.ts";

export const PLAN_VERSION = 2;
export type PropertyMap = Record<string, unknown>;
export interface RecordPage {
  object: "page"; id: string; parent: { type: string; data_source_id?: string };
  archived: boolean; in_trash: boolean; properties: PropertyMap; cover?: unknown; icon?: unknown;
}
export interface SyncAction {
  key: string; kind: "create" | "update" | "archive"; pageId?: string; before?: string;
  gameId?: string; properties: PropertyMap;
}
export interface SyncCounts { create: number; update: number; archive: number; unchanged: number; unmatched: number; skipped: number }
export interface SyncPlan {
  version: typeof PLAN_VERSION; inputDigest: string; stateDigest: string; actions: SyncAction[]; counts: SyncCounts;
}
export interface SyncProgress {
  completed: { key: string; pageId: string; kind: SyncAction["kind"] }[];
  pending: { key: string; kind: SyncAction["kind"]; pageId?: string; stage: "requesting" | "written" } | null;
  verified: boolean;
}
export const normalizedId = (value: string) => value.replaceAll("-", "").toLowerCase();
const readonlyTypes = new Set(["formula", "rollup", "created_time", "last_edited_time", "created_by", "last_edited_by", "unique_id", "button"]);
const asObject = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};

// Notion dates round-trip to minutes in this connection; source seconds remain in the private snapshot.
function minute(value: unknown): unknown {
  if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(Math.floor(time / 60000) * 60000).toISOString() : value;
}
function productUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value), app = /^\/app\/(\d+)(?:\/|$)/.exec(url.pathname);
    return url.protocol === "https:" && url.hostname === "store.steampowered.com" && app
      ? `https://store.steampowered.com/app/${app[1]}/` : value;
  } catch { return value; }
}
/** Compare API property values with request values, preserving null versus a real zero. */
export function propertyValue(value: unknown): unknown {
  const p = asObject(value), type = p.type ?? Object.keys(p).find(k => k !== "id");
  if (type === "rich_text" || type === "title") return (p[type] ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("");
  if (type === "select" || type === "status") return p[type]?.name ?? null;
  if (type === "relation") return { ids: (p.relation ?? []).map((r: any) => normalizedId(r.id)).sort(), more: p.has_more === true };
  if (type === "date") return p.date == null ? null : [minute(p.date.start), minute(p.date.end ?? null)];
  if (type === "url") return productUrl(p.url);
  return p[type ?? ""];
}
export const equalProperty = (a: unknown, b: unknown) => digest(propertyValue(a)) === digest(propertyValue(b));

function stable(value: unknown, file = false): unknown {
  if (Array.isArray(value)) return value.map(v => stable(v, file));
  if (value && typeof value === "object") {
    const obj = asObject(value), isDate = typeof obj.start === "string";
    file ||= obj.type === "file";
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !(file && k === "expiry_time")).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, isDate && (k === "start" || k === "end") ? minute(v) : stable(v, file || k === "file" && typeof asObject(v).url === "string")]));
  }
  if (file && typeof value === "string" && value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (url.hostname.endsWith(".amazonaws.com") || url.hostname.endsWith(".notionusercontent.com")) {
        url.search = ""; return url.toString();
      }
    } catch { /* A text field need not be a URL. */ }
  }
  return value;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)) ?? "undefined").digest("hex");
}
export function writableProperties(page: RecordPage, game = false): PropertyMap {
  return Object.fromEntries(Object.entries(page.properties).filter(([name, prop]) =>
    !readonlyTypes.has(asObject(prop).type) && !(game && name === "Platform Records")));
}
export function fingerprint(page: RecordPage, game = false): string {
  return digest({ id: normalizedId(page.id), parent: page.parent, archived: page.archived, in_trash: page.in_trash,
    properties: writableProperties(page, game), cover: page.cover ?? null, icon: page.icon ?? null });
}
export function recordPage(value: unknown, sourceId: string): RecordPage {
  const p = asObject(value);
  if (p.object !== "page" || typeof p.id !== "string" || !p.properties) throw new GameSyncError("NOTION_SCOPE_INCOMPLETE");
  if (p.parent?.type !== "data_source_id" || normalizedId(p.parent.data_source_id ?? "") !== normalizedId(sourceId)) {
    throw new GameSyncError("NOTION_SCOPE_INVALID");
  }
  return p as RecordPage;
}
export function requireSamePlan(expected: unknown, actual: SyncPlan): void {
  if (asObject(expected).version !== PLAN_VERSION) throw new GameSyncError("DRY_RUN_REQUIRED");
  if (digest(expected) !== digest(actual)) throw new GameSyncError("PLAN_CHANGED");
}
