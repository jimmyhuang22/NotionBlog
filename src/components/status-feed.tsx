"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Page, StatusEntry } from "../../contracts/content.ts";
import { StatusTimeline } from "./status-timeline";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { readStatusHash, statusFocusHref } from "../lib/status-focus.ts";
import { useToday } from "./use-today";

export function StatusFeed({ initial, pageSize, timeZone, year = null, total = null }: {
  initial: Page<StatusEntry>; pageSize: number; timeZone: string;
  /** The moment the page was built on the server; the first render names recent days by it. */
  /** Year filter as sent to the list endpoint: "2026", "undated" or null for everything. */
  year?: string | null;
  total?: number | null;
}) {
  const router = useRouter();
  const today = useToday(timeZone);
  const query: Record<string, string> = { limit: String(pageSize), ...(year ? { year } : {}) };
  const { items, restarted, appendedFrom, paged, ...paging } = usePagedList<StatusEntry>("/api/content/status", query, initial);
  useEffect(() => {
    const locate = () => {
      const id = readStatusHash(window.location.hash);
      if (!id || document.getElementById(id) || new URLSearchParams(window.location.search).get("focus") === id) return;
      router.replace(statusFocusHref(id));
    };
    locate();
    window.addEventListener("hashchange", locate);
    return () => window.removeEventListener("hashchange", locate);
  }, [router, items]);
  if (!items.length) return <div className="state"><p>{year === "undated" ? "没有未记日期的动态。" : year ? "这一年没有动态。" : "还没有动态。"}</p></div>;
  return (
    <>
      {restarted ? <p className="notice timeline__notice" role="status">动态有更新，已从最新一条重新加载。</p> : null}
      {/* The status page has no section heading between its title and the months. */}
      <StatusTimeline items={items} timeZone={timeZone} today={today} level={2} appendedFrom={appendedFrom} />
      {paged ? <ListTail className="timeline__more" paging={paging} label="加载更早的动态" end="到底了" status={pagingMessage(paging.problem, items.length, "条", total)} /> : null}
    </>
  );
}
