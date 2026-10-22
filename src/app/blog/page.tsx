import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostList } from "@/components/post-list";
import { contentRepository } from "@/lib/content";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../config/features.ts";

export const metadata: Metadata = { title: "博客" };

const PAGE_SIZE = 12;

type Props = { searchParams: Promise<{ tag?: string | string[] }> };

/** Only a tag the list endpoint would accept is passed on; anything else shows the full list. */
function readTag(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

export default async function BlogPage({ searchParams }: Props) {
  // The section stays invisible until posts are switched on.
  if (!isEnabledContentKind("post")) notFound();
  const tag = readTag((await searchParams).tag);
  const initial = await contentRepository.list("post", { limit: PAGE_SIZE, ...(tag ? { tag } : {}) });
  return (
    <div className="wrap wrap--narrow">
      <header className="page-head">
        <h1>博客</h1>
        {tag ? (
          <p className="posts__filter">
            <span className="tag tag--sky">标签：{tag}</span>
            <Link href="/blog">查看全部文章</Link>
          </p>
        ) : null}
      </header>
      {/* Keyed by tag so changing the filter starts a fresh list instead of reusing the old cursor. */}
      <PostList key={tag ?? ""} initial={initial} pageSize={PAGE_SIZE} tag={tag} timeZone={getSiteConfig().timeZone} />
    </div>
  );
}
