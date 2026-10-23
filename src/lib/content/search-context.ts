import type { AnyContent, StudyNote } from "../../../contracts/content.ts";
import type { SearchContext } from "../../../contracts/website.ts";
import { sanitizePublicText } from "../../server/notion/public-text.ts";

export const SEARCH_CONTEXT_VERSION = "study-context-v1";
export const MAX_CONTEXT_DEPTH = 32;
const MAX_LABEL = 256;
const MAX_CONTEXT = 4096;

function label(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = sanitizePublicText(value).trim();
  return text && text.length <= MAX_LABEL ? text : null;
}

/** Unknown/oversized labels omit the whole trail rather than silently dropping a level. */
export function makeSearchContext(code: unknown, title: unknown, parents: unknown, courseId?: string): SearchContext | null {
  if (!Array.isArray(parents) || parents.length > MAX_CONTEXT_DEPTH) return null;
  const candidate = typeof code === "string" && code.replaceAll("-", "").toLowerCase() === courseId?.replaceAll("-", "").toLowerCase() ? null : label(code);
  const courseLabel = candidate ?? label(title), parentLabels = parents.map(label);
  if (!courseLabel || parentLabels.some(value => value === null) || courseLabel.length + parentLabels.join("").length > MAX_CONTEXT) return null;
  return { courseLabel, parentLabels: parentLabels as string[] };
}

/** The map must already contain only currently eligible metadata. Follow identities, never URLs. */
export function contextFromItems(note: StudyNote, items: ReadonlyMap<string, AnyContent>): SearchContext | null {
  const course = items.get(note.courseId);
  if (!course || course.kind !== "course") return null;
  const parents: string[] = [], seen = new Set([note.id]);
  let parentId = note.parentId;
  while (parentId !== null && parentId !== course.id) {
    if (seen.has(parentId) || parents.length >= MAX_CONTEXT_DEPTH) return null;
    seen.add(parentId);
    const parent = items.get(parentId);
    if (!parent || parent.kind !== "study-note" || parent.courseId !== course.id) return null;
    parents.unshift(parent.title);
    parentId = parent.parentId;
  }
  return makeSearchContext(course.code, course.title, parents, course.id);
}
