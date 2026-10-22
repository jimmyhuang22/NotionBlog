import { hash, noteIdentity, object, SocialSyncError, timestamp } from "./model.ts";
import type { Target, XiaohongshuObservation } from "./model.ts";
import { noteObservation } from "./xiaohongshu.ts";

export const XHS_HTTP_PAGE_BYTES = 2 * 1024 * 1024;
export const XHS_HTTP_TIMEOUT_MS = 15000;

function httpObject(value: unknown, field: "NOTE_STATE" | "CURRENT_ID" | "DETAIL_MAP" | "DETAIL_ENTRY" | "NOTE" | "AUTHOR" | "COUNTERS" | "COVER") {
  try { return object(value); }
  catch { throw new SocialSyncError(`NOTE_HTTP_${field}_INVALID`); }
}

/** A public share locator is not an arbitrary fetch destination. It is retained only on the SSD. */
export function checkedNoteShareUrl(value: string, target: Target): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SocialSyncError("XHS_HTTP_LINK_INVALID"); }
  if (target.platform !== "xiaohongshu" || value.length > 4096 || url.protocol !== "https:" ||
    url.hostname !== "www.xiaohongshu.com" || url.port || url.username || url.password || url.hash ||
    !new RegExp(`^/(?:explore|discovery/item|user/profile/${noteIdentity(target.accountId)})/${noteIdentity(target.publicationId)}/?$`).test(url.pathname) ||
    !/^[A-Za-z0-9_=-]{16,255}$/.test(url.searchParams.get("xsec_token") ?? "")) throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
  const allowed = new Set(["source", "xhsshare", "xsec_token", "xsec_source"]);
  if ([...url.searchParams.keys()].some(k => !allowed.has(k) || url.searchParams.getAll(k).length !== 1)) throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
  return value;
}

/** Preserve quoted text while converting only the inert undefined token used by SSR JSON. */
function jsonWithNulls(value: string): string {
  let result = "", quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted) {
      result += char;
      if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (value.startsWith("new Map([])",i)&&!/[A-Za-z0-9_$]/.test(value[i-1]??"")) {result+="{}";i+=10;}
    else if (value.startsWith("undefined", i) && !/[A-Za-z0-9_$]/.test(value[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(value[i + 9] ?? "")) {
      result += "null"; i += 8;
    } else result += char;
  }
  return result;
}
export function httpNoteState(html: string): Record<string, unknown> {
  if (Buffer.byteLength(html) > XHS_HTTP_PAGE_BYTES) throw new SocialSyncError("PAGE_TOO_LARGE");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(m => /^\s*window\.__INITIAL_STATE__\s*=\s*/.test(m[1]!) ? m[1]! : null).filter(s => s !== null);
  if (scripts.length !== 1) throw new SocialSyncError("PAGE_STATE_MISSING");
  const script = scripts[0]!, start = /^\s*window\.__INITIAL_STATE__\s*=\s*/.exec(script)![0].length;
  if (script[start] !== "{") throw new SocialSyncError("PAGE_STATE_INVALID");
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new SocialSyncError("PAGE_STATE_INVALID");
  try { return object(JSON.parse(jsonWithNulls(script.slice(start, end)))); }
  catch { throw new SocialSyncError("PAGE_STATE_INVALID"); }
}
/** HTTP evidence has its own provenance; it never masquerades as a Chrome capture. */
export function httpNoteObservation(html: string, target: Target, at = new Date().toISOString()): XiaohongshuObservation {
  if (target.platform !== "xiaohongshu") throw new SocialSyncError("IDENTITY_MISMATCH");
  const state = httpNoteState(html), notes = httpObject(state.note, "NOTE_STATE");
  const current = typeof notes.currentNoteId === "object" && notes.currentNoteId !== null ? httpObject(notes.currentNoteId, "CURRENT_ID").value : notes.currentNoteId;
  if (current && current !== target.publicationId) throw new SocialSyncError("IDENTITY_MISMATCH");
  const map = httpObject(notes.noteDetailMap, "DETAIL_MAP");
  if (!Object.hasOwn(map, target.publicationId)) throw new SocialSyncError(Object.keys(map).length?"IDENTITY_MISMATCH":"NOTE_BROWSER_REQUIRED");
  const note = httpObject(httpObject(map[target.publicationId], "DETAIL_ENTRY").note, "NOTE"),
    user = httpObject(note.user, "AUTHOR"), info = httpObject(note.interactInfo, "COUNTERS");
  if (note.noteId !== target.publicationId || user.userId !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  if (!Object.hasOwn(info, "likedCount") || !Object.hasOwn(info, "commentCount")) throw new SocialSyncError("NOTE_COUNTERS_MISSING");
  const images = Array.isArray(note.imageList) ? note.imageList : [], cover = images[0] ? httpObject(images[0], "COVER").urlDefault : null;
  return noteObservation({ noteId: note.noteId, userId: user.userId, type: note.type, title: note.title,
    time: note.time ?? null, lastUpdateTime: note.lastUpdateTime ?? null, coverUrl: cover ?? null,
    interactInfo: { likedCount: info.likedCount ?? null, commentCount: info.commentCount ?? null,
      shareCount: info.shareCount ?? null, collectedCount: info.collectedCount ?? null } }, target, timestamp(at), "public-note-page-ssr", hash(html));
}
