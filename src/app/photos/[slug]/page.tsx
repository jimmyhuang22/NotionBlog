import Link from "next/link";
import { cache } from "react";
import type { Metadata } from "next";
import { contentMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";
import { RichDocumentBody } from "@/components/rich-document";
import { contentRepository } from "@/lib/content";
import { albumMeta } from "@/lib/album";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../../config/features.ts";
import { freshWhenUncached } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ slug: string }> };

/** One read shared by the metadata and the page within a request. */
const getAlbum = cache((slug: string) => contentRepository.get("album", slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const item = (await getAlbum((await params).slug))?.item ?? null;
    return { ...contentMetadata(item), title: item?.title ?? "相册" };
  } catch {
    return { ...contentMetadata(null), title: "相册" };
  }
}

export default async function AlbumPage({ params }: Props) {
  await freshWhenUncached();
  if (!isEnabledContentKind("album")) notFound();
  const detail = await getAlbum((await params).slug);
  if (!detail) notFound();
  const { item, document } = detail;
  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="面包屑">
        <Link href="/photos">相册</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
      </nav>
      <header className="album-head">
        <h1>{item.title}</h1>
        <p>{albumMeta(item, getSiteConfig().timeZone)}</p>
        {item.summary ? <p className="album-head__summary">{item.summary}</p> : null}
      </header>
      <div className="album">
        <RichDocumentBody document={document} emptyText="这个相册还没有照片。" imagePreviewWidth={400} />
      </div>
    </div>
  );
}
