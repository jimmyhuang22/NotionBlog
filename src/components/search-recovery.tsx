"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { searchHref } from "../lib/search.ts";

/** Retry the submitted URL, including its section, without changing the search field. */
export function SearchRetry({ busy }: { busy: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="search-recovery" aria-busy={pending}>
      <p role="status">{pending ? "正在搜索…" : busy ? "暂时搜不了，请稍后再试。" : "这次搜索没有成功，请稍后再试。"}</p>
      <button type="button" className="search-recovery__action" disabled={pending} onClick={() => {
        if (!pending) startTransition(() => router.refresh());
      }}>{pending ? "正在搜索…" : "重新搜索"}</button>
    </div>
  );
}

/** An empty section can be widened; an already-wide search only needs its field. */
export function SearchEmpty({ query, kind }: { query: string; kind: string | null }) {
  return (
    <div className="search-recovery">
      <p role="status">没有找到包含“{query}”的内容。</p>
      {kind ? (
        <Link className="search-recovery__action" href={searchHref(query, null)} prefetch={false}>搜索全部栏目</Link>
      ) : (
        <button type="button" className="search-recovery__action" onClick={() => {
          const field = document.querySelector<HTMLInputElement>(".search__input");
          field?.focus();
          field?.select();
        }}>修改关键词</button>
      )}
    </div>
  );
}
