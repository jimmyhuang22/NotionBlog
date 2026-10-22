import { hash, noteCount, noteCoverUrl, noteIdentity, noteMetricNames, noteUrl, object, publicationKey,
  SocialSyncError, text, timestamp, validateObservation } from "./model.ts";
import type { Target, XiaohongshuObservation } from "./model.ts";

export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
const fields = ["noteId", "userId", "type", "title", "time", "lastUpdateTime", "coverUrl", "interactInfo"];
const counters = { likes: "likedCount", comments: "commentCount", shares: "shareCount", collections: "collectedCount" } as const;
function shape(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw new SocialSyncError("SNAPSHOT_INVALID");
  return row;
}
function milliseconds(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 253402300799999) throw new SocialSyncError("INVALID_TIME");
  return new Date(value).toISOString();
}
/** Fixed HTTP failure categories survive the existing receipts without retaining response values. */
function noteField<T>(source: XiaohongshuObservation["source"], field: string, parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (source === "public-note-page-ssr" && error instanceof SocialSyncError &&
      ["INVALID_DATA", "INVALID_COUNT", "INVALID_TIME"].includes(error.code)) throw new SocialSyncError(`NOTE_HTTP_${field}_INVALID`);
    throw error;
  }
}
/** One normalized projection, with provenance and digest supplied by the actual capture route. */
export function noteObservation(raw: unknown, target: Target, observedAt: string,
  source: XiaohongshuObservation["source"], responseSha256: string): XiaohongshuObservation {
  if (target.platform !== "xiaohongshu") throw new SocialSyncError("IDENTITY_MISMATCH");
  const note = shape(raw, fields), page = noteUrl(target.url);
  if (page.publicationId !== target.publicationId || noteIdentity(note.noteId) !== target.publicationId ||
    noteIdentity(note.userId) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  if (note.type !== "normal" && note.type !== "video") throw new SocialSyncError("NOTE_TYPE_UNSUPPORTED");
  const info = shape(note.interactInfo, Object.values(counters));
  const metrics: XiaohongshuObservation["metrics"] = { views: null, likes: null, comments: null, shares: null, collections: null, coins: null, danmaku: null };
  const metricDisplay = {} as XiaohongshuObservation["metricDisplay"];
  for (const name of noteMetricNames) {
    const parsed = noteField(source, name.toUpperCase(), () => noteCount(info[counters[name]])); metrics[name] = parsed.exact; metricDisplay[name] = parsed.display;
  }
  const row: XiaohongshuObservation = { version: 2, platform: "xiaohongshu", workId: target.workId,
    accountId: target.accountId, publicationId: target.publicationId, kind: note.type === "video" ? "video" : "image-note",
    originalUrl: page.url, title: noteField(source, "TITLE", () => text(note.title)), description: null,
    coverUrl: noteField(source, "COVER", () => noteCoverUrl(note.coverUrl)),
    publishedAt: noteField(source, "PUBLISHED_TIME", () => milliseconds(note.time)),
    updatedAt: noteField(source, "UPDATED_TIME", () => milliseconds(note.lastUpdateTime)), observedAt: timestamp(observedAt),
    metricsScope: "individual-note", metrics, metricDisplay, collection: null, source, responseSha256,
    websitePublicationApproved: false };
  noteField(source, "PROJECTION", () => validateObservation(row)); return row;
}
/** Accept only the narrow, locally captured projection, never a full state/comments/cookie dump. */
export function snapshotObservation(value: unknown, target: Target, now = new Date().toISOString()): XiaohongshuObservation {
  if (target.platform !== "xiaohongshu") throw new SocialSyncError("IDENTITY_MISMATCH");
  const snapshot = shape(value, ["version", "source", "observedAt", "pageUrl", "note"]);
  if (snapshot.version !== 1 || snapshot.source !== "browser-note-state") throw new SocialSyncError("SNAPSHOT_INVALID");
  const observedAt = timestamp(text(snapshot.observedAt));
  const age = Date.parse(timestamp(now)) - Date.parse(observedAt);
  if (age < -30000 || age > MAX_SNAPSHOT_AGE_MS) throw new SocialSyncError("SNAPSHOT_EXPIRED");
  const page = noteUrl(snapshot.pageUrl), configured = noteUrl(target.url);
  const note = shape(snapshot.note, fields);
  if (page.url !== snapshot.pageUrl || configured.url !== target.url || configured.publicationId !== target.publicationId ||
      page.publicationId !== target.publicationId || noteIdentity(note.noteId) !== target.publicationId || noteIdentity(note.userId) !== target.accountId) {
    throw new SocialSyncError("IDENTITY_MISMATCH");
  }
  return noteObservation(note, target, observedAt, "browser-note-state", hash(JSON.stringify(snapshot)));
}
/** Validate the complete file before any database mutation; replay uses the original observation time. */
export function snapshotBatch(raw: string, targets: Target[], now = new Date().toISOString()): XiaohongshuObservation[] {
  if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new SocialSyncError("SNAPSHOT_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new SocialSyncError("SNAPSHOT_INVALID"); }
  const batch = shape(parsed, ["version", "snapshots"]);
  if (batch.version !== 1 || !Array.isArray(batch.snapshots) || batch.snapshots.length < 1 || batch.snapshots.length > 20) throw new SocialSyncError("SNAPSHOT_INVALID");
  const allowed = new Map(targets.filter(t => t.platform === "xiaohongshu").map(t => [t.publicationId, t]));
  // Different expected authors for a single platform ID would make lookup ambiguous.
  if (allowed.size !== targets.filter(t => t.platform === "xiaohongshu").length) throw new SocialSyncError("INVALID_CONFIG");
  const seen = new Set<string>();
  return batch.snapshots.map(value => {
    // The console bridge uses UTF-8 base64 so browsers cannot shorten URL links in the result.
    if (typeof value === "string") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new SocialSyncError("SNAPSHOT_INVALID");
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"))); }
      catch { throw new SocialSyncError("SNAPSHOT_INVALID"); }
    }
    const id = noteUrl(object(value).pageUrl).publicationId, target = allowed.get(id);
    if (!target) throw new SocialSyncError("UNCONFIGURED_PUBLICATION");
    const row = snapshotObservation(value, target, now), key = publicationKey(row);
    if (seen.has(key)) throw new SocialSyncError("DUPLICATE_PUBLICATION");
    seen.add(key); return row;
  });
}
/** Our own read-only page snippet. It emits projected metadata only; no network or comment traversal. */
export function browserCaptureScript(targets: Target[]): string {
  const notes = targets.filter(t => t.platform === "xiaohongshu");
  if (!notes.length) throw new SocialSyncError("INVALID_CONFIG");
  const allowed = Object.fromEntries(notes.map(t => [t.publicationId, t.accountId]));
  if (Object.keys(allowed).length !== notes.length) throw new SocialSyncError("INVALID_CONFIG");
  return `(() => {
  const allowed = ${JSON.stringify(allowed)};
  const match = /^\\/(?:explore|discovery\\/item)\\/([a-f0-9]{24})\\/?$/.exec(location.pathname);
  if (location.protocol !== "https:" || location.hostname !== "www.xiaohongshu.com" || !match || !Object.hasOwn(allowed, match[1])) throw new Error("UNCONFIGURED_PUBLICATION");
  const id = match[1], state = window.__INITIAL_STATE__?.note;
  const current = state?.currentNoteId?.__v_isRef === true ? state.currentNoteId.value : state?.currentNoteId;
  if (current && current !== id) throw new Error("IDENTITY_MISMATCH");
  if (!state?.noteDetailMap || !Object.hasOwn(state.noteDetailMap, id)) throw new Error("NOTE_STATE_MISSING");
  const note = state.noteDetailMap[id]?.note;
  if (!note || note.noteId !== id || note.user?.userId !== allowed[id]) throw new Error("IDENTITY_MISMATCH");
  const info = note.interactInfo;
  if (!info) throw new Error("NOTE_STATE_MISSING");
  const snapshot = { version: 1, source: "browser-note-state", observedAt: new Date().toISOString(),
    pageUrl: "https://www.xiaohongshu.com/explore/" + id,
    note: { noteId: note.noteId, userId: note.user.userId, type: note.type, title: note.title,
      time: note.time ?? null, lastUpdateTime: note.lastUpdateTime ?? null,
      coverUrl: note.imageList?.[0]?.urlDefault ?? null,
      interactInfo: { likedCount: info.likedCount ?? null, commentCount: info.commentCount ?? null,
        shareCount: info.shareCount ?? null, collectedCount: info.collectedCount ?? null } } };
  return "SOCIAL_SYNC_SNAPSHOT " + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(snapshot))));
})();\n`;
}
