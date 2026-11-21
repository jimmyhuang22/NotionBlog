import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ContentByKind, ContentDetail, ContentKind } from "../../contracts/content.ts";
import { isEnabledContentKind } from "../../config/features.ts";
import { contentRepository } from "./content/index.ts";
import { freshWhenUncached } from "./page-freshness.ts";
import { contentMetadata } from "./seo/metadata.ts";

type Params = { params: Promise<{ slug: string }> };

/**
 * The read shared by a plain detail page (a post, a project, an album) and its metadata: one read per request,
 * nothing at all while the section is switched off, and the section's own word as the title when the item is
 * missing or cannot be read. Each page still writes `export const revalidate = 86399` itself (Next needs it literal).
 */
export function detailRoute<K extends ContentKind>(kind: K, fallbackTitle: string) {
  const read = cache((slug: string) => contentRepository.get(kind, slug));

  async function generateMetadata({ params }: Params): Promise<Metadata> {
    try {
      const item = isEnabledContentKind(kind) ? (await read((await params).slug))?.item ?? null : null;
      return { ...contentMetadata(item), title: item?.title ?? fallbackTitle };
    } catch {
      return { ...contentMetadata(null), title: fallbackTitle };
    }
  }

  /** The page's detail, or the not-found page when the section is off or the item is not public. */
  async function load({ params }: Params): Promise<ContentDetail<ContentByKind[K]>> {
    await freshWhenUncached();
    if (!isEnabledContentKind(kind)) notFound();
    const detail = await read((await params).slug);
    if (!detail) notFound();
    return detail;
  }

  return { generateMetadata, load };
}
