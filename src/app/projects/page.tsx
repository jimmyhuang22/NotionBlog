import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectList } from "@/components/project-list";
import { contentRepository } from "@/lib/content";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;
export const metadata: Metadata = { title: "项目" };

const PAGE_SIZE = 24;

export default async function ProjectsPage() {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  // The section stays invisible until projects are switched on.
  if (!isEnabledContentKind("project")) notFound();
  const initial = await contentRepository.list("project", { limit: PAGE_SIZE });
  return (
    <div className="wrap wrap--narrow">
      <header className="page-head">
        <h1>项目</h1>
      </header>
      <ProjectList initial={initial} pageSize={PAGE_SIZE} timeZone={getSiteConfig().timeZone} />
    </div>
  );
}
