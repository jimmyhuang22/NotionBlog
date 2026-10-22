import { HomeHero, RecentFallback, TimelineHead } from "@/components/home-hero";

/**
 * The home page's loading state is the home page itself, introduction and all, with the timeline's
 * faint bars: when the page arrives nothing moves. Every other section has its own loading state
 * (the plain one is components/page-loading.tsx), so this one is only ever shown for the home page.
 */
export default function Loading() {
  return (
    <>
      {/* Tells page-switch.tsx this is still the loading state; it shows nothing. */}
      <span data-page-loading hidden />
      <HomeHero />
      <section className="wrap wrap--narrow timeline" aria-labelledby="recent">
        <TimelineHead />
        <RecentFallback />
      </section>
    </>
  );
}
