import Link from "next/link";
import { LinkPending } from "@/components/link-pending";
import type { Metadata } from "next";
import { SearchResults } from "@/components/search-results";
import { contentRepository } from "@/lib/content";
import { MAX_QUERY, readQuery, searchHref, searchKinds } from "@/lib/search";
import { isEnabledContentKind } from "../../../config/features.ts";
import type { Page } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SearchHit } from "../../../contracts/website.ts";

export const dynamic = "force-dynamic";
// Result pages are views of other pages, not content of their own.
export const metadata: Metadata = { title: "搜索", robots: { index: false, follow: false } };

const PAGE_SIZE = 12;

type Props = { searchParams: Promise<{ q?: string | string[]; kind?: string | string[] }> };

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const typed = typeof params.q === "string" ? params.q.trim() : "";
  const query = readQuery(params.q);
  // Only sections that are switched on can be searched or offered as a filter.
  const sections = searchKinds.filter(([value]) => isEnabledContentKind(value));
  const kind = sections.find(([value]) => value === params.kind)?.[0] ?? null;

  let results: Page<SearchHit> | null = null;
  let problem: "busy" | "failed" | null = null;
  if (query) {
    try {
      results = await contentRepository.search({ q: query, limit: PAGE_SIZE, ...(kind ? { kinds: [kind] } : {}) });
    } catch (error) {
      // The form stays usable when the content service is slow or down.
      problem = error instanceof ContentServiceError && error.code === "RATE_LIMITED" ? "busy" : "failed";
    }
  }

  return (
    <div className="wrap wrap--narrow search">
      <header className="page-head"><h1>搜索</h1></header>
      <form className="search__form" role="search" action="/search" method="get">
        <button type="submit" className="search__submit" aria-label="搜索">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="m12 12 3.5 3.5" /></svg>
        </button>
        <input className="search__input" type="search" name="q" defaultValue={typed.slice(0, MAX_QUERY)} maxLength={MAX_QUERY} placeholder="搜标题和正文" aria-label="搜索内容" autoComplete="off" enterKeyHint="search" autoFocus={!typed} />
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
      </form>
      {query && sections.length > 1 ? (
        <nav className="search__kinds" aria-label="按栏目筛选">
          {[[null, "全部"] as const, ...sections].map(([value, label]) => (
            <Link key={value ?? "all"} className={value === kind ? "tag tag--sky" : "tag"} href={searchHref(query, value)} aria-current={value === kind ? "true" : undefined} prefetch={false}>{label}<LinkPending /></Link>
          ))}
        </nav>
      ) : null}
      <div className="search__body">
        {!typed ? null
          : !query ? <div className="state"><p>这个关键词太长，或者包含无法搜索的字符。缩短一些再试。</p></div>
          : problem ? <div className="state"><p>{problem === "busy" ? "暂时搜不了，请稍后再试。" : "这次搜索没有成功，请稍后再试。"}</p></div>
          : results ? <SearchResults key={`${query}:${kind ?? "all"}`} initial={results} query={query} kind={kind} pageSize={PAGE_SIZE} />
          : null}
      </div>
    </div>
  );
}
