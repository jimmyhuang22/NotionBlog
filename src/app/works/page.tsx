import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkPending } from "@/components/link-pending";
import { ScrollingSegments } from "@/components/scrolling-segments";
import { SortToggle } from "@/components/sort-toggle";
import { WorksList } from "@/components/works-list";
import { WorksPlatformIcon } from "@/components/works-platform-icon";
import { WorksShell } from "@/components/works-shell";
import { socialTimelineRepository, isSocialWorksEnabled } from "@/lib/content/social-timeline";
import { getSiteConfig } from "@/lib/site";
import { worksHref, worksPlatforms } from "@/lib/works";
import { hasYear, readYear, yearTabs } from "@/lib/year-filter";

/** The page has a name only while it exists. */
export function generateMetadata(): Metadata {
  return isSocialWorksEnabled() ? { title: "作品" } : {};
}

const PAGE_SIZE = 20;
type Props = { searchParams: Promise<{ platform?: string | string[]; year?: string | string[]; order?: string | string[] }> };

/**
 * Everything published on other platforms, one platform at a time (the owner's choice, 2026-10-18):
 * Bilibili by default, newest first or by views; Xiaohongshu newest first or by likes. Since 2026-11-20 a
 * row of years sits under the head, as on the shelves (the owner's pick 甲): the platform stays beside the
 * title, the order moves to the end of the year row. Anything else in the address falls back to the default.
 * It exists only while the social source is switched on; demo works require the explicit mock setting.
 */
export default async function WorksPage({ searchParams }: Props) {
  if (!isSocialWorksEnabled()) notFound();
  const requested = await searchParams;
  const section = worksPlatforms.find(entry => entry.value === requested.platform) ?? worksPlatforms[0]!;
  const order = requested.order === section.order ? section.order : null;
  const asked = readYear(requested.year);
  // The default platform is left out of the address, but always asked for explicitly.
  const read = (year: typeof asked) => socialTimelineRepository.listWorks({ platform: section.value, ...(year === null ? {} : { year }), ...(order ? { order } : {}), limit: PAGE_SIZE });
  const first = await read(asked);
  // A year this platform has no works in (an old or hand-made address) shows every year, as the shelves do.
  const year = hasYear(first.yearCounts, asked) ? asked : null;
  const initial = year === asked ? first : await read(null);
  const selected = year === null ? null : String(year);
  const yearChoices = yearTabs(initial.yearCounts);
  const site = getSiteConfig();
  const newest = { label: "最近", mark: "swap" as const }, ranked = { label: section.orderLabel, mark: "swap" as const };
  return (
    <div className="wrap works">
      {/* Not keyed by the platform: the shell stays through a switch and draws it (F40). A switch starts on every year. */}
      <WorksShell current={section.value}
        choices={worksPlatforms.map(entry => ({ value: entry.value, label: entry.label, href: worksHref(entry.value, null), icon: <WorksPlatformIcon platform={entry.value} /> }))}
        filters={<>
          {/* With one year and nothing undated there is nothing to switch between. */}
          {yearChoices.length > 2 ? (
            <ScrollingSegments label="按年份浏览" current={selected}>
              {yearChoices.map(choice => (
                <Link key={choice.value ?? "all"} href={worksHref(section.value, order, readYear(choice.value ?? undefined))} prefetch={false} aria-current={choice.value === selected ? "true" : undefined} title={`${choice.count} 件`}>{choice.label}<LinkPending /></Link>
              ))}
            </ScrollingSegments>
          ) : null}
          {/* Always at the end of the year row, also where there is none, so the order never changes place. */}
          <SortToggle href={worksHref(section.value, order ? null : section.order, year)} now={order ? ranked : newest} next={order ? newest : ranked} />
        </>}>
        {/* Keyed by every choice so a change starts a fresh list instead of reusing the old cursor. Taken after the read, so nothing on the first page was sampled later than it. */}
        <WorksList key={`${section.value}:${selected ?? "all"}:${order ?? "newest"}`} initial={initial} platform={section.value} year={selected} order={order} pageSize={PAGE_SIZE} timeZone={site.timeZone} />
      </WorksShell>
    </div>
  );
}
