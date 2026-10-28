import Link from "next/link";
import { cache } from "react";
import type { Metadata } from "next";
import { contentMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";
import { TocList } from "@/components/blocks";
import { PostPager } from "@/components/post-pager";
import { RichDocumentBody } from "@/components/rich-document";
import { contentRepository } from "@/lib/content";
import { CoverImage } from "@/components/cover-image";
import { rangeLabel } from "@/lib/format";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../../config/features.ts";
import { freshWhenUncached } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ slug: string }> };

/** One read shared by the metadata and the page within a request. */
const getPost = cache((slug: string) => contentRepository.get("post", slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const post = isEnabledContentKind("post") ? await getPost((await params).slug) : null;
    return { ...contentMetadata(post?.item ?? null), title: post?.item.title ?? "文章" };
  } catch {
    return { ...contentMetadata(null), title: "文章" };
  }
}

export default async function PostPage({ params }: Props) {
  await freshWhenUncached();
  if (!isEnabledContentKind("post")) notFound();
  const detail = await getPost((await params).slug);
  if (!detail) notFound();
  const { item, document } = detail;
  const toc = document?.toc ?? [];
  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="面包屑">
        <Link href="/blog">博客</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
      </nav>
      <div className={toc.length ? "reading__body reading__body--toc" : "reading__body post"}>
        <article className="reading__article card">
          <p className="post__date">{rangeLabel(item.publishedAt, getSiteConfig().timeZone) ?? "日期未记录"}</p>
          <h1 className="reading__title post__title">{item.title}</h1>
          {item.summary ? <p className="post__summary">{item.summary}</p> : null}
          {item.tags.length ? (
            <p className="reading__tags post__tags">
              {item.tags.map(name => <Link key={name} className="tag" href={`/blog?tag=${encodeURIComponent(name)}`} prefetch={false}>{name}</Link>)}
            </p>
          ) : null}
          {item.cover ? <CoverImage className="post__cover" image={item.cover} previewWidth={800} label="文章封面" /> : null}
          {toc.length ? <details className="toc-drawer"><summary>本页目录</summary><TocList toc={toc} /></details> : null}
          <RichDocumentBody document={document} emptyText="这篇文章还没有正文。" imagePreviewWidth={800} />
        </article>
        {toc.length ? (
          <nav className="reading__toc" aria-label="本页目录">
            <p className="eyebrow" style={{ paddingBottom: 6 }}>本页目录</p>
            <TocList toc={toc} />
          </nav>
        ) : null}
      </div>
      <div className={toc.length ? undefined : "post__after"}><PostPager adjacent={detail.adjacent} /></div>
    </div>
  );
}
