import { ContentServiceError } from "../../contracts/repository.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { PublicNotionPage } from "../../src/server/notion/website-repository.ts";
import { collectionOwnerDigest } from "./media-refresh-scope.ts";

export interface PublicationOwnerChange {
  ownerId: string;
  expectedDigest: string;
  currentDigest: string | null;
  kind: "unavailable" | "ownership" | "revision";
  changedPaths: string[];
}
function view(owner: PublicNotionPage) {
  const identity = (p: PublicNotionPage["page"]) => ({ id: normalizeId(p.id), parent: p.parent,
    edited: p.last_edited_time, archived: p.archived, trash: p.in_trash, isArchived: p.is_archived });
  return { page: identity(owner.page), source: owner.source,
    course: owner.course ? { page: identity(owner.course.page), source: owner.course.source } : null,
    ancestors: owner.ancestors.map(identity) };
}
export function publicationOwnerChange(expected: PublicNotionPage, current: PublicNotionPage | null): PublicationOwnerChange | null {
  const expectedDigest = collectionOwnerDigest(expected), currentDigest = current ? collectionOwnerDigest(current) : null;
  if (expectedDigest === currentDigest) return null;
  if (!current) return { ownerId: normalizeId(expected.page.id), expectedDigest, currentDigest, kind: "unavailable", changedPaths: ["qualification"] };
  const before = view(expected), after = view(current), changedPaths: string[] = [];
  for (const key of ["source", "course.source"] as const) {
    const a = key === "source" ? before.source : before.course?.source;
    const b = key === "source" ? after.source : after.course?.source;
    if (configDigest(a ?? null) !== configDigest(b ?? null)) changedPaths.push(key);
  }
  const pages = (v: typeof before) => [v.page, v.course?.page ?? null, ...v.ancestors];
  const a = pages(before), b = pages(after);
  if (a.length !== b.length) changedPaths.push("ancestors.length");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const prefix = i === 0 ? "page" : i === 1 ? "course" : `ancestors.${i - 2}`;
    if (!a[i] || !b[i]) { if (a[i] !== b[i]) changedPaths.push(prefix); continue; }
    for (const key of ["id", "parent", "edited", "archived", "trash", "isArchived"] as const)
      if (configDigest(a[i]![key] ?? null) !== configDigest(b[i]![key] ?? null)) changedPaths.push(`${prefix}.${key}`);
  }
  return { ownerId: normalizeId(expected.page.id), expectedDigest, currentDigest,
    kind: changedPaths.length > 0 && changedPaths.every(p => p.endsWith(".edited")) ? "revision" : "ownership", changedPaths };
}

/** IDs and revisions belong only in the private worker receipt, never API/console output. */
export class PublicationRevalidationError extends ContentServiceError {
  readonly publicationChange: PublicationOwnerChange;
  constructor(change: PublicationOwnerChange) {
    super("CONTENT_UNAVAILABLE", "Collection ownership changed before publication.");
    this.publicationChange = change;
  }
}
export interface PublicationRevalidationProgress {
  pass: number;
  phase: "checking" | "changed" | "repaired" | "complete";
  checkedPages: number;
  repairedPages: number;
  change?: PublicationOwnerChange;
}
