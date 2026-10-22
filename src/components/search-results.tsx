"use client";

import Link from "next/link";
import type { Page } from "../../contracts/content.ts";
import type { SearchHit } from "../../contracts/website.ts";
import { kindLabels, kindMarks, readableExcerpt, searchResultHref, splitMatch } from "../lib/search.ts";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { ARRIVING_ROWS, arrivalStyle, useFilterArrival } from "./use-filter-arrival";
import { SearchEmpty } from "./search-recovery";

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
      <ol className="search__hits" aria-label="搜索结果">
        {items.map((hit, index) => (
          <li key={`${hit.kind}:${hit.id}`} className={arriving && index < ARRIVING_ROWS ? "is-arriving" : undefined} style={arriving && index < ARRIVING_ROWS ? arrivalStyle(index) : undefined}>
            <Link className="search-hit" href={searchResultHref(hit)} prefetch={false}>
              <span className="search-hit__top">
                {/* A kind is one character in a ring (2026-10-20), its name read out. */}
                <span className="search-hit__kind" title={kindLabels[hit.kind] ?? "内容"}><i aria-hidden="true">{kindMarks[hit.kind] ?? "内"}</i><span className="visually-hidden">{kindLabels[hit.kind] ?? "内容"}</span></span>
                <span className="search-hit__title"><Marked text={hit.title} query={query} /></span>
              </span>
              {hit.excerpt ? <span className="search-hit__excerpt"><Marked text={readableExcerpt(hit.excerpt)} query={query} /></span> : null}
            </Link>
          </li>
        ))}
      </ol>
      {paged ? <ListTail className="library__more" paging={paging} label="加载更多" status={pagingMessage(paging.problem, items.length, "条", total)} /> : null}
    </>
  );
}
