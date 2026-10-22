import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryGrid } from "@/components/library-grid";
import { LinkPending } from "@/components/link-pending";
import { ScrollingSegments } from "@/components/scrolling-segments";
import { SortToggle } from "@/components/sort-toggle";
import { FILTER_TRANSITION } from "@/lib/transitions";
import { contentRepository } from "@/lib/content";
import { libraryHref, libraryOrders, librarySections, type LibraryItem } from "@/lib/library";
import { getSiteConfig } from "@/lib/site";
import { hasYear, readYear, yearTabs, type YearChoice } from "@/lib/year-filter";
import { isEnabledContentKind } from "../../../../config/features.ts";
import type { LibraryKind, LibraryYears, Page } from "../../../../contracts/content.ts";

const PAGE_SIZE = 24;

type Props = { params: Promise<{ type: string }>; searchParams: Promise<{ status?: string | string[]; order?: string | string[]; year?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: librarySections[(await params).type]?.label ?? "作品" };
}

/** The year counts are an aid: if they cannot be read the list still shows, without the year switch. */
async function readYears(kind: LibraryKind, status: string | null): Promise<LibraryYears | null> {
  try {
    return await contentRepository.getLibraryYears(kind, status ? { status } : {});
  } catch {
    return null;
  }
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
  const list = (year: YearChoice) => contentRepository.list(section.kind, { limit: PAGE_SIZE, ...(status ? { status } : {}), ...(year === null ? {} : { year }), ...(order ? { order } : {}) }) as Promise<Page<LibraryItem>>;
  const [first, years] = await Promise.all([list(asked), readYears(section.kind, status)]);
  // A year carried over from another status may have nothing under this one; the whole status shows instead of an empty year.
  const year = years && !hasYear(years, asked) ? null : asked;
  const initial = year === asked ? first : await list(year);
  const selected = year === null ? null : String(year);
  const tabs = section.tabs;
  const yearChoices = years ? yearTabs(years) : [];
  return (
    <div className="wrap">
      <header className="page-head library__head">
        <h1>{section.label}</h1>
        <nav className="segmented" aria-label="按状态筛选">
          {tabs.map(([value, label]) => (
            <Link key={value} href={libraryHref(type, value, order, year)} aria-current={value === status ? "true" : undefined} transitionTypes={FILTER_TRANSITION}>{label}<LinkPending /></Link>
          ))}
        </nav>
      </header>
      <div className="library__filters">
        {/* With one year and nothing undated there is nothing to switch between. */}
        {yearChoices.length > 2 ? (
          <ScrollingSegments label="按年份浏览" current={selected}>
            {yearChoices.map(choice => (
              <Link key={choice.value ?? "all"} href={libraryHref(type, status, order, readYear(choice.value ?? undefined))} aria-current={choice.value === selected ? "true" : undefined} title={`${choice.count} ${section.unit}`} transitionTypes={FILTER_TRANSITION}>{choice.label}<LinkPending /></Link>
            ))}
          </ScrollingSegments>
        ) : null}
        {/* Always at the end of the year row, also where there is none, so every status puts it in the same place. */}
        <SortToggle href={libraryHref(type, status, order ? null : "date-asc", year)}
          now={order ? { label: "最早", mark: "up" } : { label: "最近", mark: "down" }}
          next={order ? { label: "最近", mark: "down" } : { label: "最早", mark: "up" }} />
      </div>
      {/* Keyed by every choice so a change starts a fresh list instead of reusing the old cursor. */}
      <LibraryGrid key={`${status}:${selected ?? "all"}:${order ?? "default"}`} kind={section.kind} status={status} year={selected} order={order} unit={section.unit} initial={initial} pageSize={PAGE_SIZE} timeZone={getSiteConfig().timeZone} />
    </div>
  );
}
