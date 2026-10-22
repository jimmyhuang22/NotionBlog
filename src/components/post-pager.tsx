import Link from "next/link";
import type { ContentLink } from "../../contracts/content.ts";

/** The posts published just after and just before this one, as reported with the article itself. */
export function PostPager({ adjacent }: { adjacent: { newer: ContentLink | null; older: ContentLink | null } | undefined }) {
  if (!adjacent || (!adjacent.newer && !adjacent.older)) return null;
  const { newer, older } = adjacent;
  return (
    <nav className="pager" aria-label="相邻的文章">
      {newer ? <Link prefetch={false} href={newer.href}><span>较新一篇</span><span>{newer.title}</span></Link> : null}
      {older ? <Link prefetch={false} className="pager__next" href={older.href}><span>较早一篇</span><span>{older.title}</span></Link> : null}
    </nav>
  );
}
