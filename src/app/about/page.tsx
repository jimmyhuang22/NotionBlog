import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { RichDocumentBody } from "@/components/rich-document";
import { SocialLinks } from "@/components/social-links";
import { contentRepository } from "@/lib/content";
import { updatedLabel } from "@/lib/format";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";

export const metadata: Metadata = { title: "关于" };

/**
 * One page the owner maintains in the content source. The picture, name, bio and social links
 * above it come from the site configuration, as on the home page.
 */
export default async function AboutPage() {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  // The address stays unavailable until the page is switched on and actually published.
  if (!isEnabledContentKind("page")) notFound();
  const page = await contentRepository.getPage("about");
  if (!page) notFound();
  const site = getSiteConfig();
  const name = site.profile.name ?? site.siteName;
  const updated = updatedLabel(page.updatedAt, site.timeZone);
  return (
    <div className="wrap wrap--narrow about">
      <section className="hero">
        <Avatar src={site.profile.avatar} name={name} />
        <h1>关于</h1>
        <p className="hero__bio">{[site.profile.name, site.profile.bio].filter(Boolean).join(" · ") || site.siteName}</p>
        <SocialLinks links={site.socials} />
      </section>
      <article className="reading__article card" aria-label={page.title}>
        <RichDocumentBody document={page.document} emptyText="这一页还没有内容。" imagePreviewWidth={800} />
      </article>
      {updated ? <p className="about__updated">{updated}</p> : null}
    </div>
  );
}
