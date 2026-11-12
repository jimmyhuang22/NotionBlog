import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SortToggle } from "@/components/sort-toggle";
import { WorksList } from "@/components/works-list";
import { WorksPlatformIcon } from "@/components/works-platform-icon";
import { WorksShell } from "@/components/works-shell";
import { socialTimelineRepository, isSocialWorksEnabled } from "@/lib/content/social-timeline";
import { getSiteConfig } from "@/lib/site";
import { worksHref, worksPlatforms } from "@/lib/works";

/** The page has a name only while it exists. */
export function generateMetadata(): Metadata {
  return isSocialWorksEnabled() ? { title: "作品" } : {};
}

const PAGE_SIZE = 20;
type Props = { searchParams: Promise<{ platform?: string | string[]; order?: string | string[] }> };

/**
 * Everything published on other platforms, one platform at a time (the owner's choice, 2026-10-18):
 * Bilibili by default, newest first or by views; Xiaohongshu newest first or by likes. Anything else
 * in the address falls back to the default. It exists only while the social source is switched on;
 * demo works require the explicit mock setting.
 */
export default async function WorksPage({ searchParams }: Props) {
  if (!isSocialWorksEnabled()) notFound();
  const requested = await searchParams;
  const section = worksPlatforms.find(entry => entry.value === requested.platform) ?? worksPlatforms[0]!;
  const order = requested.order === section.order ? section.order : null;
  // The default platform is left out of the address, but always asked for explicitly.
  const initial = await socialTimelineRepository.listWorks({ platform: section.value, ...(order ? { order } : {}), limit: PAGE_SIZE });
  const site = getSiteConfig();
  const newest = { label: "最近", mark: "swap" as const }, ranked = { label: section.orderLabel, mark: "swap" as const };
  return (
    <div className="wrap works">
      {/* Not keyed by the platform: the shell stays through a switch and draws it (F40). */}
      <WorksShell current={section.value}
        choices={worksPlatforms.map(entry => ({ value: entry.value, label: entry.label, href: worksHref(entry.value, null), icon: <WorksPlatformIcon platform={entry.value} /> }))}
        sort={<SortToggle href={worksHref(section.value, order ? null : section.order)} now={order ? ranked : newest} next={order ? newest : ranked} />}>
        {/* Keyed by both choices so a change starts a fresh list instead of reusing the old cursor. Taken after the read, so nothing on the first page was sampled later than it. */}
        <WorksList key={`${section.value}:${order ?? "newest"}`} initial={initial} platform={section.value} order={order} pageSize={PAGE_SIZE} timeZone={site.timeZone} />
      </WorksShell>
    </div>
  );
}
