import assert from "node:assert/strict";
import type { Course, StudyNote } from "../../contracts/content.ts";
import { studyPreorder } from "../../src/server/notion/study-order.ts";
import { validateStudyCheckpoint, type StudyChangeSource, type StudyCheckpoint, type StudyEntry,
  type StudyObservation, type StudyReadOptions } from "../../src/server/notion/study-incremental.ts";

/** Fictional worker-only inputs; no Notion credentials, shared fixtures, or cloud reads. */
export const syntheticId = (value: number) => value.toString(16).padStart(32, "0");
export const changedTime = "2026-01-02T00:00:00.000Z";
export const studyItem = (entry: StudyEntry) => entry.record.detail.item as Course | StudyNote;
const parent = (entry: StudyEntry) => entry.record.evidence.parentId;

export function syntheticEntry(value: number, courseId: string | null = null, parentId: string | null = null,
  bodySize = 32, position = 0): StudyEntry {
  const id = syntheticId(value), isCourse = courseId === null;
  const common = { id, slug: id, href: isCourse ? `/study/${id}` : `/study/${courseId}/notes/${id}`,
    title: `Note ${String(value).padStart(5, "0")}`, summary: null, tags: [], cover: null,
    updatedAt: "2026-01-01T00:00:00.000Z" };
  const item: Course | StudyNote = isCourse
    ? { ...common, kind: "course", code: null, semester: null,
      ratings: { experience: null, usefulness: null, recommendation: null, difficulty: null } }
    : { ...common, kind: "study-note", courseId, parentId: parentId === courseId ? null : parentId,
      noteType: "note", date: null, breadcrumbs: [] };
  return { override: null, position: isCourse ? null : position, record: {
    detail: { item, document: { blocks: [{ id: "body", type: "paragraph", text: [{ text: "x".repeat(bodySize) }] }],
      toc: [], completeness: "complete" } },
    evidence: { sourceKey: isCourse ? "courses" : "notes", dataSourceId: syntheticId(900000),
      databaseParentId: null, courseId, parentId: isCourse ? null : parentId, ordinal: isCourse ? 0 : position },
  } };
}

function normalize(entries: StudyEntry[]): StudyEntry[] {
  const byId = new Map(entries.map(entry => [studyItem(entry).id, entry]));
  for (const entry of entries) {
    const item = studyItem(entry);
    if (item.kind === "course") continue;
    const ancestors: StudyNote["breadcrumbs"] = [], seen = new Set<string>();
    let ownerId = parent(entry);
    while (ownerId !== null) {
      assert.ok(!seen.has(ownerId), "Synthetic inputs must have an acyclic physical parent chain");
      seen.add(ownerId);
      const owner = byId.get(ownerId); assert.ok(owner);
      ancestors.unshift({ title: studyItem(owner).title, href: studyItem(owner).href });
      ownerId = parent(owner);
    }
    item.breadcrumbs = ancestors;
  }
  for (const entry of entries) if (studyItem(entry).kind === "course") {
    const notes = entries.filter(note => {
      const item = studyItem(note); return item.kind === "study-note" && item.courseId === studyItem(entry).id;
    });
    const ordered = studyPreorder(notes.map(note => ({ item: studyItem(note) as StudyNote,
      override: note.override, bodyPosition: note.position ?? undefined })));
    for (const [ordinal, note] of ordered.entries()) byId.get(note.id)!.record.evidence.ordinal = ordinal;
  }
  return entries;
}

function checkpoint(entries: StudyEntry[]): StudyCheckpoint {
  const result = { version: "v1", sourceDigest: "a".repeat(64), entries: normalize(entries) };
  validateStudyCheckpoint(result);
  return result;
}

export function smallStudyCheckpoint(): StudyCheckpoint {
  const id = syntheticId;
  const entries = [syntheticEntry(1), syntheticEntry(2), syntheticEntry(10, id(1), id(1), 32, 0),
    syntheticEntry(11, id(1), id(1), 32, 1), syntheticEntry(12, id(1), id(10), 32, 0),
    syntheticEntry(13, id(1), id(12), 32, 0), syntheticEntry(14, id(1), id(10), 32, 1),
    syntheticEntry(20, id(2), id(2), 32, 0)];
  const target = studyItem(entries.find(entry => studyItem(entry).id === id(12))!);
  const document = entries.find(entry => studyItem(entry).id === id(11))!.record.detail.document!;
  document.blocks.push({ id: "reference", type: "child-page", title: target.title,
    target: { title: target.title, href: target.href } },
  { id: "heading", type: "heading", level: 2,
    text: [{ text: target.title, pageMention: true, link: { kind: "internal", href: target.href } }] });
  document.toc.push({ id: "heading", title: target.title, level: 2 });
  return checkpoint(entries);
}

/** Mixed inputs have four courses, 50-note branches, and depth up to ten. */
export function largeStudyCheckpoint(notes: number, shape: "wide" | "mixed", bodySize = 32): StudyCheckpoint {
  assert.ok(Number.isSafeInteger(notes) && notes >= 4);
  const courseCount = shape === "wide" ? 1 : 4;
  const entries = Array.from({ length: courseCount }, (_, index) => syntheticEntry(index + 1));
  const perCourse = Math.ceil(notes / courseCount);
  for (let index = 0; index < notes; index++) {
    const course = Math.floor(index / perCourse), local = index % perCourse;
    const groupStart = index - local % 50, offset = local % 50;
    let owner = syntheticId(course + 1);
    if (shape === "mixed" && offset > 0) owner = syntheticId(1000 + groupStart + (offset < 9 ? offset - 1 : offset % 9));
    entries.push(syntheticEntry(1000 + index, syntheticId(course + 1), owner, bodySize, local));
  }
  return checkpoint(entries);
}

type WithdrawalReason = Extract<StudyObservation, { state: "withdrawn" }>["reason"];
export function syntheticStudySource(checkpoint: StudyCheckpoint) {
  const current = new Map(structuredClone(checkpoint.entries).map(entry => [studyItem(entry).id, entry]));
  const withdrawn = new Map<string, WithdrawalReason>();
  const calls: [string, StudyReadOptions][] = [];
  const rebuild = () => normalize([...current.values()]);
  function move(id: string, ownerId: string): void {
    const entry = current.get(id), owner = current.get(ownerId); assert.ok(entry && owner);
    const item = studyItem(entry), ownerItem = studyItem(owner);
    assert.equal(item.kind, "study-note"); if (item.kind !== "study-note") throw new Error("Expected a note");
    const courseId = ownerItem.kind === "course" ? ownerItem.id : ownerItem.courseId;
    entry.record.evidence.parentId = ownerId; item.parentId = ownerId === courseId ? null : ownerId;
    const pending = [id];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const child = current.get(pending[cursor])!, childItem = studyItem(child);
      assert.equal(childItem.kind, "study-note"); if (childItem.kind !== "study-note") throw new Error("Expected a note");
      childItem.courseId = courseId; child.record.evidence.courseId = courseId;
      childItem.href = `/study/${courseId}/notes/${childItem.slug}`;
      for (const [key, candidate] of current) if (parent(candidate) === pending[cursor]) pending.push(key);
    }
    rebuild();
  }
  const source: StudyChangeSource = { sourceDigest: checkpoint.sourceDigest, read: async (id, options) => {
    calls.push([id, { ...options }]);
    const reason = withdrawn.get(id); if (reason) return { state: "withdrawn", reason };
    const entry = current.get(id); assert.ok(entry, `Missing synthetic source ${id}`);
    const ancestors: string[] = []; let ownerId = parent(entry);
    while (ownerId !== null) {
      ancestors.unshift(ownerId); const owner = current.get(ownerId); assert.ok(owner); ownerId = parent(owner);
    }
    const children = options.children ? [...current.values()]
      .filter(child => parent(child) === id && !withdrawn.has(studyItem(child).id))
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      .map(child => ({ id: studyItem(child).id, position: child.position ?? child.record.evidence.ordinal,
        updatedAt: studyItem(child).updatedAt })) : undefined;
    return { state: "active", entry: structuredClone(entry), ancestors, ...(children ? { children } : {}) };
  } };
  return { current, withdrawn, calls, source, move, rebuild };
}

export type SyntheticStudySource = ReturnType<typeof syntheticStudySource>;
