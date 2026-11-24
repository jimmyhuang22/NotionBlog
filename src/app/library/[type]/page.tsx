import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryGrid } from "@/components/library-grid";
import { Suspense } from "react";
import { LinkPending } from "@/components/link-pending";
import { RecentGamesWaiting } from "@/components/recent-games";
import { RecentGamesSection } from "@/components/recent-games-section";
import { ScrollingSegments, Segments } from "@/components/scrolling-segments";
import { SortToggle } from "@/components/sort-toggle";
import { readLibraryFirstPage } from "@/lib/content";
import { libraryHref, libraryOrders, librarySections } from "@/lib/library";
import { getSiteConfig } from "@/lib/site";
import { readYear, yearTabs } from "@/lib/year-filter";
import { isEnabledContentKind } from "../../../../config/features.ts";

const PAGE_SIZE = 24;

type Props = { params: Promise<{ type: string }>; searchParams: Promise<{ status?: string | string[]; order?: string | string[]; year?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: librarySections[(await params).type]?.label ?? "作品" };
}

export default async function LibraryPage({ params, searchParams }: Props) {
  const { type } = await params;
  const section = librarySections[type];
  // A section stays invisible until its content kind is switched on.
  if (!section || !isEnabledContentKind(section.kind)) notFound();
  const requested = await searchParams;
  // There is no "all": a section opens on its default status, and anything other than a known tab falls back to it.
  const status = section.tabs.find(([value]) => value === requested.status)?.[0] ?? section.defaultStatus;
  const order = libraryOrders.find(([value]) => value !== null && value === requested.order)?.[0] ?? null;
  const asked = readYear(requested.year);
  const { page: initial, years, year } = await readLibraryFirstPage(section.kind, {
    limit: PAGE_SIZE, ...(status ? { status } : {}), ...(asked === null ? {} : { year: asked }), ...(order ? { order } : {}),
  });
  const selected = year === null ? null : String(year);
  const tabs = section.tabs;
  const yearChoices = years ? yearTabs(years) : [];
  const timeZone = getSiteConfig().timeZone;
  const statusTabs = (
    <Segments label="按状态筛选" current={status}>
      {tabs.map(([value, label]) => (
        <Link key={value} href={libraryHref(type, value, order, year)} aria-current={value === status ? "true" : undefined}>{label}<LinkPending /></Link>
      ))}
    </Segments>
  );
  const sort = (
    <SortToggle href={libraryHref(type, status, order ? null : "date-asc", year)}
      now={order ? { label: "最早", mark: "up" } : { label: "最近", mark: "down" }}
      next={order ? { label: "最近", mark: "down" } : { label: "最早", mark: "up" }} />
  );
  const yearCounts = Object.fromEntries(yearChoices.flatMap(choice => choice.value === null ? [] : [[choice.value, choice.count]]));
  // Keyed by every choice so a change starts a fresh list instead of reusing the old cursor.
  const listKey = `${status}:${selected ?? "all"}:${order ?? "default"}`;

  // Games (乙, 2026-11-24): one rail from top to bottom. 最近在玩 is its first part and each year one more, the part's
  // name in a column on the left; the years are written there, so there is no year row, and the order sits beside
  // the statuses. 最近在玩 streams in on its own, so the library never waits for it, and it does not follow the
  // statuses (丙, 2026-11-24). An address with ?year= still lists that year alone.
  if (section.kind === "game") return (
    <div className="wrap wrap--wide">
      <header className="page-head library__head">
        <h1>{section.label}</h1>
        <div className="library__head-tools">{sort}{statusTabs}</div>
      </header>
      <div className="game-rail">
        <Suspense fallback={<RecentGamesWaiting />}><RecentGamesSection timeZone={timeZone} /></Suspense>
        <LibraryGrid key={listKey} kind={section.kind} status={status} year={selected} order={order} unit={section.unit} initial={initial} pageSize={PAGE_SIZE} timeZone={timeZone}
          yearCounts={yearCounts} runLabel={tabs.find(([value]) => value === status)?.[1] ?? section.label} />
      </div>
    </div>
  );

  return (
    <div className="wrap">
      <header className="page-head library__head">
        <h1>{section.label}</h1>
        {statusTabs}
      </header>
      <div className="library__filters">
        {/* With one year and nothing undated there is nothing to switch between. */}
        {yearChoices.length > 2 ? (
          <ScrollingSegments label="按年份浏览" current={selected}>
            {yearChoices.map(choice => (
              <Link key={choice.value ?? "all"} href={libraryHref(type, status, order, readYear(choice.value ?? undefined))} aria-current={choice.value === selected ? "true" : undefined} title={`${choice.count} ${section.unit}`}>{choice.label}<LinkPending /></Link>
            ))}
          </ScrollingSegments>
        ) : null}
        {/* Always at the end of the year row, also where there is none, so every status puts it in the same place. */}
        {sort}
      </div>
      <LibraryGrid key={listKey} kind={section.kind} status={status} year={selected} order={order} unit={section.unit} initial={initial} pageSize={PAGE_SIZE} timeZone={timeZone} />
    </div>
  );
}
