import "./fonts/nunito.css";
import Link from "next/link";
import type { Metadata } from "next";
import { contentFeatures } from "../../config/features.ts";
import type { ContentKind } from "../../contracts/content.ts";
import { BackToTop } from "@/components/back-to-top";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { penScript } from "@/lib/pen-once";
import { SearchPalette } from "@/components/search-palette";
import { PageTransition } from "@/components/page-transition";
import { PenStroke } from "@/components/pen-stroke";
import { ThemeControls } from "@/components/theme-toggle";
import { notionIconPath } from "@/components/social-icon-paths";
import { getContentProvider } from "@/lib/content";
import { isSocialEnabled } from "@/lib/content/social";
import { getSiteConfig } from "@/lib/site";
import { inputModeScript } from "@/lib/input-mode";
import { themeScript } from "@/lib/skins";
import { discoveryOptions } from "@/lib/seo/discovery";
import { siteMetadata } from "@/lib/seo/metadata";
import { publicCacheEnabled } from "@/server/public-cache/policy";
import "./globals.css";
import "./timeline.css";
import "./prose.css";
import "./study.css";
import "./library.css";
import "./motion.css";
import "./skins.css";


export function generateMetadata(): Metadata {
  const { siteName } = getSiteConfig();
  return {
    ...siteMetadata(siteName),
    // One tab icon per theme; theme-toggle.tsx repoints them when the visitor picks a theme by hand.
    icons: {
      icon: [
        { url: "/site-icon/light", type: "image/png", media: "(prefers-color-scheme: light)" },
        { url: "/site-icon/dark", type: "image/png", media: "(prefers-color-scheme: dark)" },
      ],
      apple: "/site-icon/apple",
    },
  };
}

/**
 * A section appears in the navigation only once its content kind is enabled; `more` ones fold under
 * "更多" when the row would hold more than fits a phone. The about page is reached from the home
 * page's picture, not from here.
 */
const sections: { kind: ContentKind; href: string; label: string; more?: boolean }[] = [
  { kind: "status", href: "/status", label: "动态" },
  { kind: "course", href: "/study", label: "学习" },
  { kind: "post", href: "/blog", label: "博客" },
  { kind: "movie", href: "/library/movies", label: "影视", more: true },
  { kind: "book", href: "/library/books", label: "书籍", more: true },
  { kind: "game", href: "/library/games", label: "游戏", more: true },
  { kind: "album", href: "/photos", label: "相册", more: true },
  { kind: "project", href: "/projects", label: "项目" },
];

/** The feed only carries entries once the site is open to discovery; until then there is nothing to subscribe to. */
function hasFeed(): boolean {
  try { return discoveryOptions(process.env).enabled; } catch { return false; }
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const site = getSiteConfig();
  const nav: NavItem[] = sections.filter(section => contentFeatures[section.kind]).map(({ href, label, more }) => ({ href, label, more }));
  // Works published elsewhere are a section of their own while the social source is on. It sits before the
  // library sections, which fold under "更多" once the row holds more than fits a phone.
  if (isSocialEnabled()) {
    const firstFoldable = nav.findIndex(item => item.more);
    nav.splice(firstFoldable === -1 ? nav.length : firstFoldable, 0, { href: "/works", label: "作品" });
  }
  return (
    <html lang="zh-CN" className="font-nunito" data-scroll-behavior="smooth" data-public-cache={publicCacheEnabled() ? "tagged-v1" : undefined} suppressHydrationWarning>
      {/* The script's text must come from a plain module. Taken from a "use client" file it reaches the browser as a reference to that file's code, and the page then waits on it while becoming interactive; when that code arrived late, hydration failed now and then. */}
      <head><script dangerouslySetInnerHTML={{ __html: themeScript + inputModeScript + penScript }} /></head>
      <body>
        <a className="skip-link" href="#main">跳到正文</a>
        <header className="site-header">
          <div className="wrap wrap--wide site-header__inner">
            <Link className="site-header__brand" href="/">{site.siteName}</Link>
            <NavLinks items={nav} />
            <div className="site-header__tools">
              <SearchPalette />
              <ThemeControls />
            </div>
          </div>
        </header>
        {/* Pages cross-fade inside this boundary; see motion.css. */}
        <main id="main"><PageTransition>{children}</PageTransition></main>
        <footer className="site-footer">
          <div className="wrap wrap--wide site-footer__inner">
            <span className="site-footer__name">{site.siteName}<PenStroke className="site-footer__stroke" /></span>
            <nav className="site-footer__links" aria-label="页脚">
              {hasFeed() ? <a href="/feed.xml">订阅</a> : null}
              {site.notionSiteUrl ? <a className="site-footer__notion" href={site.notionSiteUrl} target="_blank" rel="noopener noreferrer" aria-label="Notion 源站（新标签页打开）">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d={notionIconPath} /></svg>
                <span>Notion 源站</span>
                <svg className="site-footer__external" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12 12 4M4 4h8v8" /></svg>
              </a> : null}
              <a href="#top">回到顶部 <span aria-hidden="true">↑</span></a>
            </nav>
            {/* Works published elsewhere are real even while the site's own content is the demo set. */}
            {getContentProvider() === "mock" ? <span className="site-footer__note">{isSocialEnabled() ? "除社交平台的作品外，均为演示内容" : "演示内容，不是真实记录"}</span> : null}
          </div>
        </footer>
        <BackToTop />
      </body>
    </html>
  );
}
