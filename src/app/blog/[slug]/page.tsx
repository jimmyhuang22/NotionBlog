import Link from "next/link";
import { TocList } from "@/components/blocks";
import { PostPager } from "@/components/post-pager";
import { RichDocumentBody } from "@/components/rich-document";
import { detailRoute } from "@/lib/detail-route";
import { CoverImage } from "@/components/cover-image";
import { rangeLabel } from "@/lib/format";
import { getSiteConfig } from "@/lib/site";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ slug: string }> };

const route = detailRoute("post", "文章");
export const generateMetadata = route.generateMetadata;

export default async function PostPage(props: Props) {
  const detail = await route.load(props);
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
