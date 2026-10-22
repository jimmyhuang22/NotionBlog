import { Suspense } from "react";
import { AboutDialog } from "@/components/about-dialog";
import { DirectoryRetry } from "@/components/directory-retry";
import { HomeHero, RecentFallback, TimelineHead } from "@/components/home-hero";
import { PenOnce } from "@/components/pen-once";
import { HomeTimeline } from "@/components/home-timeline";
import { homeFeedV2Repository } from "@/lib/content/home-feed-v2";
import { isAboutAvailable } from "@/lib/request-cache";
import { getSiteConfig } from "@/lib/site";
import { ContentServiceError } from "../../contracts/repository.ts";
import { alwaysFresh } from "@/lib/page-freshness";

const PAGE_SIZE = 16;

async function Recent({ timeZone }: { timeZone: string }) {
  try {
    // Merged by the home feed service: the enabled sections' updates and, when switched on, works and collections published elsewhere.
    const initial = await homeFeedV2Repository.getPage({ limit: PAGE_SIZE });
    return <HomeTimeline initial={initial} pageSize={PAGE_SIZE} timeZone={timeZone} />;
  } catch (error) {
    // The introduction stays readable when the content service is slow or down.
    return <DirectoryRetry label="动态" busy={error instanceof ContentServiceError && error.code === "RATE_LIMITED"} />;
  }
}

/** The picture leads to the about page only while that page can be read; otherwise it stays a picture. */
async function AboutEntry({ timeZone }: { timeZone: string }) {
  const site = getSiteConfig();
  return await isAboutAvailable() ? <AboutDialog timeZone={timeZone} avatar={site.profile.avatar} name={site.profile.name ?? site.siteName} /> : null;
}

export default async function HomePage() {
  await alwaysFresh();
  const site = getSiteConfig();
  return (
    <>
      {/* The about entry is laid over the picture once the check answers, so the introduction never waits for the content service. */}
      <HomeHero about={<Suspense fallback={null}><AboutEntry timeZone={site.timeZone} /></Suspense>} />
      {/* Here and not in the hero, which the loading state also draws: only the page itself counts as the stroke's moment. */}
      <PenOnce />
      <section className="wrap wrap--narrow timeline timeline--home" aria-labelledby="recent">
        <TimelineHead />
        <Suspense fallback={<RecentFallback />}><Recent timeZone={site.timeZone} /></Suspense>
      </section>
    </>
  );
}
