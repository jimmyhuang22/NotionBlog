import type { ContentBlock, ContentDocument, ContentLink, StudyNode } from "../../contracts/content.ts";

export type StudyView = "all" | "notes" | "courses" | "assignments";

/** Keep upstream order, placing a week's course before tasks with exactly the same start date. */
export function orderStudyOverview(nodes: StudyNode[]): StudyNode[] {
  const result: StudyNode[] = [];
  for (let index = 0; index < nodes.length;) {
    const start = nodes[index].date?.start;
    let end = index + 1;
    if (start) while (end < nodes.length && nodes[end].date?.start === start) end++;
    const peers = nodes.slice(index, end);
    if (start) for (let i = 1; i < peers.length; i++) {
      if (peers[i].noteType !== "course") continue;
      let position = i;
      while (position > 0 && ["Assignment", "eFolio"].includes(studyEntryType(peers[position - 1]))) position--;
      if (position !== i) peers.splice(position, 0, ...peers.splice(i, 1));
    }
    result.push(...peers);
    index = end;
  }
  return result;
}

export function studyEntryType(node: StudyNode): "Note" | "Course" | "Assignment" | "eFolio" {
  // The source DTO has no separate eFolio value; preserve its explicit title identity.
  if (/^eFolio\b/iu.test(node.title)) return "eFolio";
  if (node.noteType === "course") return "Course";
  if (["assignment", "quiz", "test"].includes(node.noteType ?? "")) return "Assignment";
  return "Note";
}

/** Interface words for the four kinds: the full name for readers and assistive technology, one character for the list mark. */
export const studyTypeLabels: Record<ReturnType<typeof studyEntryType>, { name: string; mark: string }> = {
  Course: { name: "课程", mark: "课" }, Note: { name: "笔记", mark: "记" }, Assignment: { name: "作业", mark: "作" }, eFolio: { name: "eFolio", mark: "作" },
};

interface StudyDay { year: number; month: number; day: number; time: string | null }

/**
 * "3 月 3 日 – 9 日" in the site's own date words. The semester already names the year, so a year is written only
 * when a range crosses one; the month repeats only when it changes, and a same-day range keeps just the end time.
 */
export function studyDateText(start: StudyDay, end: StudyDay | null): [string, string | null] {
  const time = (value: StudyDay) => value.time ? ` ${value.time}` : "";
  const crossesYear = !!end && end.year !== start.year;
  const first = `${crossesYear ? `${start.year} 年 ` : ""}${start.month} 月 ${start.day} 日${time(start)}`;
  if (!end) return [first, null];
  const last = crossesYear ? `${end.year} 年 ${end.month} 月 ${end.day} 日`
    : end.month !== start.month ? `${end.month} 月 ${end.day} 日`
    : end.day !== start.day ? `${end.day} 日` : "";
  // Within one day only a different time of day follows; the same time again would read "14:00 – 14:00".
  const text = last ? `${last}${time(end)}` : end.time && end.time !== start.time ? end.time : "";
  return [first, text || null];
}

export function filterStudyEntries(nodes: StudyNode[], view: StudyView, query: string): StudyNode[] {
  const q = query.trim().toLocaleLowerCase();
  return nodes.filter(node => {
    const type = studyEntryType(node);
    return (view === "all" || view === "courses" && type === "Course" || view === "notes" && type === "Note" || view === "assignments" && (type === "Assignment" || type === "eFolio"))
      && (!q || node.title.toLocaleLowerCase().includes(q));
  });
}

/** The same root sequence for the overview, directory and depth-first pager. */
export function studyReadingNodes(nodes: StudyNode[], resources: string[]): StudyNode[] {
  const excluded = new Set(resources);
  return orderStudyOverview(nodes.filter(node => !excluded.has(node.href)));
}

export interface StudySearchEntry { node: StudyNode; path: string[] }

/** An empty query retains the timeline; searching visits only the supplied, qualified tree. */
export function studyOverviewEntries(nodes: StudyNode[], view: StudyView, query: string): StudySearchEntry[] {
  if (!query.trim()) return filterStudyEntries(nodes, view, "").map(node => ({ node, path: [] }));
  function visit(siblings: StudyNode[], path: string[]): StudySearchEntry[] {
    return siblings.flatMap(node => [
      ...filterStudyEntries([node], view, query).map(node => ({ node, path })),
      ...visit(node.children ?? [], [...path, node.title]),
    ]);
  }
  return visit(nodes, []);
}

export function studyView(value: string | null): StudyView {
  return value === "notes" || value === "courses" || value === "assignments" ? value : "all";
}

/** Never infer children from references: the qualified directory is the only membership source. */
export function missingStudyChildren(nodes: StudyNode[], href: string, linkedHrefs: string[]): StudyNode[] {
  function find(siblings: StudyNode[]): StudyNode | undefined {
    for (const node of siblings) {
      if (node.href === href) return node;
      const nested = find(node.children ?? []);
      if (nested) return nested;
    }
  }
  const linked = new Set(linkedHrefs);
  return (find(nodes)?.children ?? []).filter(node => !linked.has(node.href));
}

/** Send only link addresses to the child index, not another copy of the document. */
export function documentStudyLinks(document: ContentDocument | null): string[] {
  const linked = new Set<string>();
  // Collect navigation already rendered anywhere in the AST, including inline links and toggles.
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.href === "string") linked.add(record.href.split("#")[0].split("?")[0]);
    if ((record.type === "bookmark" || record.type === "embed") && typeof record.url === "string") linked.add(record.url.split("#")[0].split("?")[0]);
    Object.values(record).forEach(visit);
  }
  visit(document?.blocks);
  return [...linked];
}

/** Already-public direct page links only, without inferring publication for descendants. */
export function courseQuickLinks(document: ContentDocument | null): ContentLink[] {
  const links = new Map<string, ContentLink>();
  function visit(blocks: ContentBlock[]) {
    for (const block of blocks) {
      if (block.type === "child-page" && block.target) links.set(block.target.href, { ...block.target, title: block.title || block.target.title });
      if (block.type === "columns") block.columns.forEach(column => visit(column.blocks));
    }
  }
  visit(document?.blocks ?? []);
  return [...links.values()];
}
