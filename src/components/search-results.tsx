"use client";

import Link from "next/link";
import type { Page } from "../../contracts/content.ts";
import type { SearchHit } from "../../contracts/website.ts";
import { hitExcerpt, kindLabels, searchResultHref, searchResultLabel, splitMatch } from "../lib/search.ts";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { ARRIVING_ROWS, arrivalStyle, useFilterArrival } from "./use-filter-arrival";
import { SearchEmpty } from "./search-recovery";
import { SearchContextLine } from "./search-context-line";

/** The excerpt is plain text from the search entry; the match is marked here, never taken as markup. */
export function Marked({ text, query }: { text: string; query: string }) {
  const parts = splitMatch(text, query);
  return parts ? <>{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</> : <>{text}</>;
}

export function SearchResults({ initial, query, kind, pageSize }: { initial: Page<SearchHit>; query: string; kind: string | null; pageSize: number }) {
  const request: Record<string, string> = { q: query, limit: String(pageSize), ...(kind ? { kinds: kind } : {}) };
  const { items, restarted, total, paged, ...paging } = usePagedList<SearchHit>("/api/search", request, initial);
  // A new kind or a new search: the first results come in one after another (motion.css).
  const arriving = useFilterArrival();
  if (!items.length) return <SearchEmpty query={query} kind={kind} />;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 16 }}>内容有更新，已重新搜索。</p> : null}
      <p className="search__count">{total ?? items.length} 条结果</p>
      <ol className="search__hits" aria-label="搜索结果">
        {items.map((hit, index) => {
          const excerpt = hitExcerpt(hit, query);
          return (
          <li key={`${hit.kind}:${hit.id}`} className={arriving && index < ARRIVING_ROWS ? "is-arriving" : undefined} style={arriving && index < ARRIVING_ROWS ? arrivalStyle(index) : undefined}>
            <Link className="search-hit" href={searchResultHref(hit)} aria-label={searchResultLabel(hit)} prefetch={false}>
              <span className="search-hit__title"><Marked text={hit.title} query={query} /></span>
              {/* Under the title, the kind in full and where it sits (2026-11-19, 甲; it replaced a one-character ring). */}
              <span className="search-hit__meta"><span className="search-hit__kind">{kindLabels[hit.kind] ?? "内容"}</span>{hit.context ? <SearchContextLine context={hit.context} /> : null}</span>
              {excerpt ? <span className="search-hit__excerpt"><Marked text={excerpt} query={query} /></span> : null}
            </Link>
          </li>
          );
        })}
      </ol>
      {paged ? <ListTail className="library__more" paging={paging} label="加载更多" status={pagingMessage(paging.problem, items.length, "条", total)} /> : null}
    </>
  );
}
