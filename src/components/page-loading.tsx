"use client";

import { usePathname } from "next/navigation";
import { sectionLoadingTitle } from "../lib/section-loading.ts";
import { SectionWaiting } from "./section-waiting";

/**
 * A section's loading state: its own drawing where it has one (section-waiting.tsx), otherwise plain bars
 * under its title. It is tall enough that the footer stays below the fold while the page is read, instead
 * of jumping down when it arrives.
 */
export function PageLoading({ title }: { title?: string } = {}) {
  const pathname = usePathname();
  const shaped = title === undefined && pathname !== null ? SectionWaiting({ path: pathname }) : null;
  if (shaped) return shaped;
  const heading = title ?? sectionLoadingTitle(pathname);
  return (
    <div className={`wrap${heading !== undefined ? "" : " wrap--narrow"} page-loading`} role="status" aria-label={heading ? `正在加载${heading}` : "正在加载"}>
      {heading ? <header className="page-head"><h1>{heading}</h1></header>
        : <span className="skeleton" data-loading-heading style={{ width: "38%", height: 40, marginBottom: 28 }} />}
      {[92, 80, 86, 60].map(width => <span key={width} className="skeleton" style={{ width: `${width}%`, height: 18, marginBottom: 16 }} />)}
    </div>
  );
}
