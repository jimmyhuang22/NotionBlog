type Target = { href: string; title: string };

function headingTitles(value: unknown, titles = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) { value.forEach(child => headingTitles(child, titles)); return titles; }
  if (!value || typeof value !== "object") return titles;
  const row = value as Record<string, unknown>;
  if (row.type === "heading" && typeof row.id === "string" && Array.isArray(row.text)) {
    titles.set(row.id, row.text.map(run => (run as { text: string }).text).join(""));
  }
  Object.values(row).forEach(child => headingTitles(child, titles));
  return titles;
}

/** Preserve authored labels while rewriting child pages and explicitly marked page mentions. */
export function rewriteStudyLinks(value: unknown, links: ReadonlyMap<string, Target | null>): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteStudyLinks(item, links));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const mentionLink = row.link as { kind?: string; href?: string } | null | undefined;
  if (row.pageMention === true && typeof row.text === "string" && mentionLink?.kind === "internal" &&
      typeof mentionLink.href === "string" && links.has(mentionLink.href)) {
    const next = links.get(mentionLink.href);
    return { ...row, text: next?.title ?? "Unavailable page",
      link: next ? { kind: "internal", href: next.href } : { kind: "unavailable" } };
  }
  if (row.type === "child-page") {
    const target = row.target as Target | null | undefined;
    if (!target) return { id: row.id, type: "child-page", title: "Unavailable page", target: null };
    if (links.has(target.href)) {
      const next = links.get(target.href);
      return { id: row.id, type: "child-page", title: next?.title ?? "Unavailable page", target: next ?? null };
    }
  }
  if (typeof row.href === "string" && links.has(row.href)) {
    const next = links.get(row.href);
    if (!next) return row.kind === "internal" ? { kind: "unavailable" } : null;
    return { ...row, href: next.href, ...("title" in row ? { title: next.title } : {}) };
  }
  const result = Object.fromEntries(Object.entries(row).map(([key, child]) => [key, rewriteStudyLinks(child, links)]));
  if (Array.isArray(row.blocks) && Array.isArray(row.toc)) {
    const before = headingTitles(row.blocks), after = headingTitles(result.blocks);
    result.toc = (result.toc as Record<string, unknown>[]).map(entry => {
      const id = entry.id as string;
      return after.has(id) && before.get(id) !== after.get(id) ? { ...entry, title: after.get(id) } : entry;
    });
  }
  return result;
}
