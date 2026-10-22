"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkPending } from "@/components/link-pending";
import { useStudyLinkContexts } from "@/components/study-reading-context";

export interface PagerLink { href: string; title: string }

/** order is the directory flattened depth-first: the sequence a reader sees. */
export function NotePager({ order }: { order: PagerLink[] }) {
  const pathname = usePathname();
  const labels = useStudyLinkContexts();
  const index = order.findIndex(link => link.href === pathname);
  // Resource pages are opened from the course header, outside the learning sequence.
  if (index < 0) return null;
  const previous = index > 0 ? order[index - 1] : null;
  const next = index < order.length - 1 ? order[index + 1] : null;
  if (!previous && !next) return null;
  return (
    <nav className="pager" aria-label="上一篇和下一篇">
      {previous ? <Link prefetch={false} href={previous.href}><span>上一篇</span><span>{previous.title}<LinkPending /></span>{labels[previous.href] ? <small className="study-link-context">{labels[previous.href]}</small> : null}</Link> : null}
      {next ? <Link prefetch={false} className="pager__next" href={next.href}><span>下一篇</span><span>{next.title}<LinkPending /></span>{labels[next.href] ? <small className="study-link-context">{labels[next.href]}</small> : null}</Link> : null}
    </nav>
  );
}
