import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { contentRepository } from "@/lib/content";
import { CoverImage } from "@/components/cover-image";
import { albumMeta } from "@/lib/album";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;
export const metadata: Metadata = { title: "相册" };

/** An album without a cover, or with one that cannot be read: its title on a tile of the same shape. */
function EmptyCover({ title }: { title: string }) {
  return <div className="album-card__cover album-card__cover--empty" aria-hidden="true"><span>{title}</span></div>;
}

export default async function PhotosPage() {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  // The section stays invisible until albums are switched on.
  if (!isEnabledContentKind("album")) notFound();
  const page = await contentRepository.list("album", { limit: 50 });
  const { timeZone } = getSiteConfig();
  return (
    <div className="wrap">
      <header className="page-head">
        <h1>相册</h1>
      </header>
      {page.items.length === 0 ? <div className="state"><p>还没有相册。</p></div> : null}
      <div className="album-grid">
        {page.items.map(album => (
          <Link key={album.id} href={album.href} prefetch={false} className="album-card">
            {/* Covers use the re-authorised media path directly, without an optimiser cache. */}
            {/* A cover that cannot be read shows the same titled tile as an album without one. */}
            {album.cover
              ? <CoverImage className="album-card__cover" image={album.cover} previewWidth={400} label={`${album.title} 的封面`} alt={`${album.title} 的封面`} lazy sized={false} fallback={<EmptyCover title={album.title} />} />
              : <EmptyCover title={album.title} />}
            <span className="album-card__title">{album.title}</span>
            <span className="album-card__meta">{albumMeta(album, timeZone)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
