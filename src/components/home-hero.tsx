import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "./avatar";
import { PenStroke } from "./pen-stroke";
import { SocialLinks } from "./social-links";
import { getSiteConfig } from "@/lib/site";

/**
 * The home page's introduction and the head of its timeline. Everything here comes from the site's
 * own settings, so the loading state draws the very same thing and the page does not move when it
 * arrives. `about` is laid over the picture once the about page is known to be readable.
 */
export function HomeHero({ about = null }: { about?: ReactNode }) {
  const site = getSiteConfig();
  const name = site.profile.name ?? site.siteName;
  return (
    <section className="wrap wrap--narrow hero hero--home">
      <div className="hero__avatar">
        <Avatar src={site.profile.avatar} name={name} />
        {about}
      </div>
      {/* Without a configured profile the generic site name stands alone, not inside a personal greeting. */}
      <h1>
        {site.profile.name ? (
          <>
            <span className="hero__greet">你好，我是 </span>
            <wbr />
            <span className="hero__name">
              {site.profile.name}
              <PenStroke className="hero__stroke" />
            </span>
          </>
        ) : site.siteName}
      </h1>
      {site.profile.bio ? <p className="hero__bio">{site.profile.bio}</p> : null}
      <SocialLinks links={site.socials} />
    </section>
  );
}

export function TimelineHead() {
  return (
    <div className="timeline__head">
      <h2 id="recent">最近</h2>
      <Link href="/status" prefetch={false}>全部动态</Link>
    </div>
  );
}

/**
 * The timeline before its entries: a month and three rows in the timeline's own classes, so the line and the
 * dots stand exactly where the timeline's will (M-16). When the entries arrive the line stays, and each row's
 * faint bars give way to its contents in place (motion.css draws the same bars under the first screen's rows).
 */
export function RecentFallback() {
  return (
    <div className="timeline-waiting" role="status" aria-label="正在加载动态">
      <div aria-hidden="true">
        <h3 className="timeline__month timeline__month--first">
          <span className="timeline__month-name"><span className="skeleton skeleton--text" style={{ width: 44 }} /></span>{" "}
          <span className="timeline__month-year"><span className="skeleton skeleton--text" style={{ width: 40 }} /></span>
        </h3>
        {[0, 1, 2].map(row => (
          <div key={row} className="entry">
            <span className="timeline-waiting__bar timeline-waiting__bar--time" />
            <span className="timeline-waiting__bar timeline-waiting__bar--long" />
            <span className="timeline-waiting__bar timeline-waiting__bar--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
