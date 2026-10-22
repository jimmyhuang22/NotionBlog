import type { CourseTree, StudyNode, StudyNote } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
const titles = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export interface StudyOrderEntry { item: StudyNote; override: number | null; bodyPosition?: number }
export function compareStudyEntries(a: StudyOrderEntry, b: StudyOrderEntry): number {
  if (a.item.parentId === null && b.item.parentId === null) {
    if (a.override !== null || b.override !== null) {
      if (a.override === null) return 1;
      if (b.override === null) return -1;
      if (a.override !== b.override) return a.override - b.override;
    }
    const ad = a.item.date?.start ?? null, bd = b.item.date?.start ?? null;
    if (ad !== bd) { if (ad === null) return 1; if (bd === null) return -1; return ad.localeCompare(bd); }
  } else if (a.bodyPosition !== undefined || b.bodyPosition !== undefined) {
    if (a.bodyPosition === undefined) return 1;
    if (b.bodyPosition === undefined) return -1;
    if (a.bodyPosition !== b.bodyPosition) return a.bodyPosition - b.bodyPosition;
  }
  return titles.compare(a.item.title, b.item.title) || a.item.id.localeCompare(b.item.id);
}
/** A single preorder controls both sync ordinals and the direct Notion tree. */
export function studyPreorder(entries: StudyOrderEntry[]): StudyNote[] {
  const groups = new Map<string | null, StudyOrderEntry[]>(), ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.item.id)) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid study hierarchy.");
    ids.add(entry.item.id);
    const siblings = groups.get(entry.item.parentId) ?? []; siblings.push(entry); groups.set(entry.item.parentId, siblings);
  }
  for (const siblings of groups.values()) siblings.sort(compareStudyEntries);
  const result: StudyNote[] = [];
  function visit(parent: string | null, depth: number) {
    if (depth > 24) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Study hierarchy exceeds its boundary.");
    for (const { item } of groups.get(parent) ?? []) { result.push(item); visit(item.id, depth + 1); }
  }
  visit(null, 0);
  if (result.length !== entries.length) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid study hierarchy.");
  return result;
}
/** Input order is preserved per sibling; database readers use staged ordinals. */
export function studyTree(notes: StudyNote[], courseId: string, parentId?: string): CourseTree | null {
  if (parentId !== undefined && !notes.some(n => n.id === parentId)) return null;
  const groups = new Map<string | null, StudyNote[]>();
  const identities=new Set(notes.map(n=>n.id));
  if(identities.size!==notes.length||notes.some(n=>n.courseId!==courseId||(n.parentId!==null&&!identities.has(n.parentId))))
    throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study hierarchy.");
  for (const note of notes) {
    const siblings = groups.get(note.parentId) ?? []; siblings.push(note); groups.set(note.parentId, siblings);
  }
  function build(parent: string | null, path: Set<string>): StudyNode[] {
    if (path.size > 24) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid study hierarchy.");
    return (groups.get(parent) ?? []).map(note => {
      if (path.has(note.id)) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid study hierarchy.");
      const children = build(note.id, new Set([...path, note.id]));
      return { id: note.id, title: note.title, href: note.href, hasChildren: children.length > 0, children, noteType: note.noteType, date: note.date };
    });
  }
  const roots=build(null,new Set());
  const count=(nodes:StudyNode[]):number=>nodes.reduce((n,node)=>n+1+count(node.children??[]),0);
  if(count(roots)!==notes.length)throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study hierarchy.");
  return { courseId, nodes: parentId===undefined?roots:build(parentId,new Set()) };
}
