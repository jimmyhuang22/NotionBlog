"use client";

import Link from "next/link";
import type { Album, Page } from "../../contracts/content.ts";
import { albumMeta } from "../lib/album.ts";
import { CoverImage } from "./cover-image";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";

/** An album without a cover, or with one that cannot be read: its title on a tile of the same shape. */
function EmptyCover({ title }: { title: string }) {
  return <div className="album-card__cover album-card__cover--empty" aria-hidden="true"><span>{title}</span></div>;
}

/**
 * The photos page's albums. The first page comes from the server; past it the list loads on, like the other
 * lists (U18, 2026-10-24: only the first 50 used to be read). With fewer albums than a page it looks exactly
 * as before: no list end is drawn.
 */
export function AlbumGrid({ initial, pageSize, timeZone }: { initial: Page<Album>; pageSize: number; timeZone: string }) {
  const { items, restarted, total, paged, ...paging } = usePagedList<Album>("/api/content/album", { limit: String(pageSize) }, initial);
  if (!items.length) return <div className="state"><p>还没有相册。</p></div>;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 20 }}>相册有更新，已从头重新加载。</p> : null}
      <div className="album-grid">
        {items.map(album => (
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
      {paged ? <ListTail className="library__more" paging={paging} label="加载更多相册" status={pagingMessage(paging.problem, items.length, "个相册", total)} /> : null}
    </>
  );
}
