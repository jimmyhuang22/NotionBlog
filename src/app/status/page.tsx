import Link from "next/link";
import { traceContentRead } from "../../server/content-read-timing.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkPending } from "@/components/link-pending";
import { ScrollingSegments } from "@/components/scrolling-segments";
import { FILTER_TRANSITION } from "@/lib/transitions";
import { StatusFeed } from "@/components/status-feed";
import { contentRepository } from "@/lib/content";
import { getSiteConfig } from "@/lib/site";
import type { Page, StatusEntry, StatusYears } from "../../../contracts/content.ts";
import { statusPreview } from "@/lib/content/status";
import { readStatusFocus } from "@/lib/status-focus";
import { readYear, yearTabs, yearTotal } from "@/lib/year-filter";

export const metadata: Metadata = { title: "动态" };

const PAGE_SIZE = 12;

type Props = { searchParams: Promise<{ year?: string | string[]; focus?: string | string[] }> };

/** The year list is an aid: if it cannot be read the timeline still shows, without the switcher. */
async function readYears(): Promise<StatusYears | null> {
  try {
    return await contentRepository.getStatusYears();
  } catch {
    return null;
  }
}

export default async function StatusPage(props: Props) {
  return traceContentRead("status-page", "status", () => readStatusPage(props));
}

async function readStatusPage({ searchParams }: Props) {
  const params = await searchParams;
  const focus = params.focus === undefined ? null : readStatusFocus(params.focus);
  if (params.focus !== undefined && !focus) notFound();
  // A focused request reads exactly that eligible record; it does not walk old list cursors.
  const year = focus ? null : readYear(params.year);
  const readPage = async (): Promise<Page<StatusEntry>> => {
    if (!focus) return contentRepository.list("status", { limit: PAGE_SIZE, ...(year === null ? {} : { year }) });
    const detail = await contentRepository.get("status", focus);
    if (!detail) notFound();
    return { items: [statusPreview(detail.item, detail.document)], nextCursor: null, hasMore: false, total: 1 };
  };
  const [page, years] = await Promise.all([
    readPage(),
    readYears(),
  ]);
  const total = years ? yearTotal(years, year) : null;
  const tabs = years ? yearTabs(years) : [];
  const selected = year === null ? null : String(year);
  return (
    <>
      <header className="wrap wrap--narrow page-head status-head">
        <h1>动态</h1>
        {tabs.length > 2 ? (
          <ScrollingSegments label="按年份浏览" current={selected}>
            {tabs.map(tab => (
              <Link key={tab.value ?? "all"} href={tab.value ? `/status?year=${tab.value}` : "/status"} aria-current={tab.value === selected ? "true" : undefined} title={`${tab.count} 条`} transitionTypes={FILTER_TRANSITION}>{tab.label}<LinkPending /></Link>
            ))}
          </ScrollingSegments>
        ) : null}
      </header>
      <section className="wrap wrap--narrow timeline" aria-label="动态时间线">
        {focus ? <p className="notice timeline__notice">已定位到这条动态。<Link href="/status" prefetch={false}>查看全部动态</Link></p> : null}
        {/* Keyed by year so switching starts a fresh list instead of reusing the old cursor. */}
        <StatusFeed key={focus ? `focus:${focus}` : selected ?? "all"} initial={page} pageSize={PAGE_SIZE} timeZone={getSiteConfig().timeZone} year={selected} total={focus ? 1 : total} />
      </section>
    </>
  );
}
