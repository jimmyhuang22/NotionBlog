import type { ContentBlock, ContentDocument } from "../../contracts/content.ts";

/** Disambiguate same-titled public children with their actual surrounding chapter, without I/O. */
export function studyLinkContexts(document: ContentDocument | null): Record<string, string> {
  const entries: { href: string; title: string; chapter: string }[] = [];
  function visit(blocks: ContentBlock[], inherited: string) {
    const levels = blocks.flatMap(block => block.type === "heading" ? [block.level] : []);
    const base = Math.min(...levels);
    let chapter = inherited;
    for (const block of blocks) {
      if (block.type === "heading" && block.level === base) chapter = block.text.map(run => run.text).join("").trim();
      if (block.type === "child-page" && block.target) entries.push({ href: block.target.href, title: block.title || block.target.title, chapter });
      if (block.type === "columns") block.columns.forEach(column => visit(column.blocks, chapter));
      if (block.type === "list") block.items.forEach(item => visit(item.children, chapter));
      if (block.type === "callout" || block.type === "toggle") visit(block.children, chapter);
    }
  }
  visit(document?.blocks ?? [], "");
  const targets = new Map<string, Set<string>>();
  entries.forEach(entry => {
    const group = targets.get(entry.title) ?? new Set<string>();
    group.add(entry.href); targets.set(entry.title, group);
  });
  const labels: Record<string, string> = {};
  for (const entry of entries) if (targets.get(entry.title)!.size > 1 && entry.chapter && !labels[entry.href]) labels[entry.href] = entry.chapter;
  return labels;
}
