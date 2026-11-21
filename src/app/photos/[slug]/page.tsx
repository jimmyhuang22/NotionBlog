import Link from "next/link";
import { RichDocumentBody } from "@/components/rich-document";
import { detailRoute } from "@/lib/detail-route";
import { albumMeta } from "@/lib/album";
import { getSiteConfig } from "@/lib/site";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ slug: string }> };

const route = detailRoute("album", "相册");
export const generateMetadata = route.generateMetadata;

export default async function AlbumPage(props: Props) {
  const detail = await route.load(props);
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
