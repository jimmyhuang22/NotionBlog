import { HomeHero, RecentFallback, TimelineHead } from "@/components/home-hero";
import { PageLoading } from "@/components/page-loading";
import { RootLoading } from "@/components/root-loading";

/**
 * The home page's loading state is the home page itself, introduction and all, with the timeline's
 * faint bars: when the page arrives nothing moves. This boundary wraps every section, though, and a
 * first visit to any address streams it before the section's own loading state, so other addresses
 * get the plain one instead (F54).
 */
export default function Loading() {
  return (
    <>
      {/* Tells page-switch.tsx this is still the loading state; it shows nothing. */}
      <span data-page-loading hidden />
      <RootLoading
        home={(
          <>
            <HomeHero />
            <section className="wrap wrap--narrow timeline timeline--home" aria-labelledby="recent">
              <TimelineHead />
              <RecentFallback />
            </section>
          </>
        )}
        other={<PageLoading />}
      />
    </>
  );
}
