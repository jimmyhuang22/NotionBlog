import type { StatusEntry, StudyNote } from "../../contracts/content.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { studyTree } from "../../src/server/notion/study-order.ts";
import { statusYears } from "../../src/lib/content/status.ts";
import { planMediaAcceptance, type AcceptanceThumbnail } from "../website-incremental-sync/media-acceptance.ts";
import type { AcceptedFullBaseline } from "../website-incremental-sync/full-baseline-artifact.ts";

export class VisitorError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "VisitorError"; this.code = code; }
}
export function visitorFail(code: string): never { throw new VisitorError(code); }
export interface VisitorLimits { durationMs: number; httpRequests: number; responseBytes: number; sqlQueries: number; sqlRowBytes: number }
export const VISITOR_MAXIMUM: VisitorLimits = { durationMs: 300000, httpRequests: 64, responseBytes: 64 * 1024 ** 2, sqlQueries: 256, sqlRowBytes: 8 * 1024 ** 2 };
export function visitorLimits(input: VisitorLimits) {
  if (!input || Object.keys(input).length !== 5 || Object.entries(VISITOR_MAXIMUM).some(([k, max]) =>
    !Number.isSafeInteger(input[k as keyof VisitorLimits]) || input[k as keyof VisitorLimits] < 1 || input[k as keyof VisitorLimits] > max)) visitorFail("VISITOR_INPUT_INVALID");
  return structuredClone(input);
}
type Expectation = { type: "health" } | { type: "list"; kind: string; ids: string[]; total: number } |
  { type: "detail"; item: { id: string; kind: string; slug: string; title: string; updatedAt: string | null }; courseId?: string; parentId?: string | null } |
  { type: "exact"; data: unknown } | { type: "about"; title: string; updatedAt: string | null } | { type: "html"; text: string } | { type: "missing"; json: boolean } |
  { type: "media"; sha256: string; byteSize: number; mime: string };
export interface VisitorRequest { name: string; path: string; expected: Expectation }

/** Private offline plan. Sample membership and media come from the SAME accepted
 * full; this does not recollect Source or perform another full media acceptance. */
export function planVisitorAcceptance(config: WebsiteNotionConfig, artifact: AcceptedFullBaseline, thumbnails: readonly AcceptanceThumbnail[], timeZone: string,
  origin: string, prefix: string, limits: VisitorLimits, mediaPolicy: "required400" | "original-only" = "required400") {
  if (!["required400", "original-only"].includes(mediaPolicy)) visitorFail("VISITOR_INPUT_INVALID");
  const quota = visitorLimits(limits);
  const base = planMediaAcceptance(config, artifact, thumbnails, { durationMs: quota.durationMs, sqlResponseBytes: quota.sqlRowBytes, controlBytes: 0 });
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || !/^[a-z0-9-]+-[0-9]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(url.hostname) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(prefix) || prefix.split("/").some(p => !p)) visitorFail("VISITOR_INPUT_INVALID");
  try { new Intl.DateTimeFormat("en", { timeZone }); } catch { visitorFail("VISITOR_INPUT_INVALID"); }
  const records = artifact.collection.records;
  const statuses = records.filter(r => r.detail.item.kind === "status").map(r => r.detail.item as StatusEntry);
  const courses = records.filter(r => r.detail.item.kind === "course").map(r => r.detail.item);
  const notes = records.filter(r => r.detail.item.kind === "study-note").map(r => r.detail.item as StudyNote);
  const course = [...courses].sort((a, b) => a.id.localeCompare(b.id)).find(c => notes.some(n => n.courseId === c.id));
  const status = [...statuses].sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!course || !status) visitorFail("VISITOR_SAMPLE_MISSING");
  const courseNotes = notes.filter(n => n.courseId === course.id), note = courseNotes.find(n => n.parentId !== null) ?? courseNotes[0];
  const item = (v: typeof course) => ({ id: v.id, kind: v.kind, slug: v.slug, title: sanitizePublicText(v.title), updatedAt: v.updatedAt });
  const e = encodeURIComponent, requests: VisitorRequest[] = [
    { name: "health", path: "/api/health/content", expected: { type: "health" } },
    { name: "status-list", path: "/api/content/status?limit=2", expected: { type: "list", kind: "status", ids: statuses.map(i => i.id), total: statuses.length } },
    { name: "status-years", path: "/api/status/years", expected: { type: "exact", data: statusYears(statuses, timeZone) } },
    { name: "status-detail", path: `/api/content/status/${e(status.slug)}`, expected: { type: "detail", item: item(status) } },
    { name: "course-list", path: "/api/content/course?limit=2", expected: { type: "list", kind: "course", ids: courses.map(i => i.id), total: courses.length } },
    { name: "course-detail", path: `/api/content/course/${e(course.slug)}`, expected: { type: "detail", item: item(course) } },
    { name: "course-tree", path: `/api/study/${e(course.slug)}/tree`, expected: { type: "exact", data: studyTree(courseNotes.map(n => ({ ...n, title: sanitizePublicText(n.title) })), course.id) } },
    { name: "note-detail", path: `/api/content/study-note/${e(note.slug)}`, expected: { type: "detail", item: item(note), courseId: course.id, parentId: note.parentId } },
    { name: "status-page", path: "/status", expected: { type: "html", text: "" } },
    { name: "note-page", path: note.href, expected: { type: "html", text: sanitizePublicText(note.title) } },
  ];
  const about = records.find(r => r.detail.item.kind === "page" && r.detail.item.slug === "about");
  if (about) requests.push({ name: "about", path: "/api/pages/about", expected: { type: "about", title: sanitizePublicText(about.detail.item.title), updatedAt: about.detail.item.updatedAt } });
  // Prefer a small representative owned image. Unreferenced stored objects are
  // not visitor samples; the independent full object acceptance covers those.
  const referenced = new Set<string>();
  function images(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(images); return; }
    const v = value as Record<string, unknown>;
    if (typeof v.src === "string" && typeof v.id === "string" && v.src === `/media/v2/${v.id}`) referenced.add(v.id);
    Object.values(v).forEach(images);
  }
  records.forEach(r => images(r.detail));
  const with400 = new Set(base.thumbnails.filter(t => t.widthCap === 400).map(t => t.parentAssetId));
  const original = [...base.media].filter(m => referenced.has(m.assetId)).sort((a, b) => Number(with400.has(b.assetId)) - Number(with400.has(a.assetId)) || a.byteSize - b.byteSize || a.assetId.localeCompare(b.assetId))[0];
  const thumbnail400SampleAvailable = !!original && with400.has(original.assetId);
  if (mediaPolicy === "required400" && !thumbnail400SampleAvailable) visitorFail("VISITOR_THUMBNAIL_SAMPLE_MISSING");
  const objects = [] as typeof base.objects;
  if (original) for (const width of [null, 400, 800] as const) {
    const selected = width === null ? original : base.thumbnails.find(t => t.parentAssetId === original.assetId && t.widthCap === width)?.thumbnail ?? original;
    requests.push({ name: width === null ? "original" : `thumbnail-${width}`, path: `/media/v2/${original.assetId}${width === null ? "" : `?thumbnail=${width}`}`,
      expected: { type: "media", sha256: selected.sha256, byteSize: selected.byteSize, mime: selected.mime } });
    if (!objects.some(m => m.objectKey === selected.objectKey)) objects.push(selected);
  }
  let absent = `visitor-absent-${base.digest.slice(0, 16)}`;
  while (records.some(r => r.detail.item.slug === absent)) absent += "x";
  let absentAsset = `a1.${configDigest(absent)}`;
  while (base.media.some(m => m.assetId === absentAsset)) absentAsset = `a1.${configDigest(absentAsset)}`;
  requests.push({ name: "unknown-note", path: `/api/content/study-note/${absent}`, expected: { type: "missing", json: true } },
    { name: "unknown-media", path: `/media/v2/${absentAsset}`, expected: { type: "missing", json: false } });
  if (requests.some(r => !r.path.startsWith("/") || r.path.startsWith("//") || /[\u0000-\u0020\u007f\\#]/.test(r.path)) ||
    requests.length + (original ? 3 : 0) > quota.httpRequests) visitorFail("VISITOR_HTTP_LIMIT");
  const bound = { format: "representative-visitor-plan-v1" as const, state: base.state, membershipDigest: base.digest,
    timeZone, origin, prefix, limits: quota, requests, objects, mediaPolicy, mediaSampleAvailable: !!original, thumbnail400SampleAvailable };
  return { ...bound, digest: configDigest(bound) };
}
export type VisitorPlan = ReturnType<typeof planVisitorAcceptance>;
