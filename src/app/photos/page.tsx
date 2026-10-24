import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { contentRepository } from "@/lib/content";
import { AlbumGrid } from "@/components/album-grid";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;
export const metadata: Metadata = { title: "相册" };

/** The first page of albums comes with the page; the list loads on past it (U18). */
const PAGE_SIZE = 50;

export default async function PhotosPage() {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  // The section stays invisible until albums are switched on.
  if (!isEnabledContentKind("album")) notFound();
  const page = await contentRepository.list("album", { limit: PAGE_SIZE });
  const { timeZone } = getSiteConfig();
  return (
    <div className="wrap">
      <header className="page-head">
        <h1>相册</h1>
      </header>
      <AlbumGrid initial={page} pageSize={PAGE_SIZE} timeZone={timeZone} />
    </div>
  );
}
