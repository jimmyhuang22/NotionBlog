type Target = { href: string; title: string };

/** Rewrite both the navigation target and the visible child-page label. */
export function rewriteStudyLinks(value: unknown, links: ReadonlyMap<string, Target | null>): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteStudyLinks(item, links));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
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
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, rewriteStudyLinks(child, links)]));
}
