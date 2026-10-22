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
    <section className="wrap wrap--narrow hero">
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
      <Link href="/status">全部动态</Link>
    </div>
  );
}

/** The line and its dots are drawn first; the entries arrive where the faint bars are. */
export function RecentFallback() {
  return (
    <div className="timeline-skeleton" role="status" aria-label="正在加载动态">
      {[[72, 54], [64], [58, 40]].map((widths, index) => (
        <div key={index}>
          <span style={{ width: 96 }} />
          {widths.map(width => <span key={width} style={{ width: `${width}%` }} />)}
        </div>
      ))}
    </div>
  );
}
