import { contentFeatures } from "../../config/features.ts";
import type { ContentKind } from "../../contracts/content.ts";
import { isSocialEnabled } from "./content/social";
import type { NavItem } from "./nav.ts";

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

/**
 * The site's sections as the header lists them; the search page and the 404 page offer the same list (2026-11-19).
 * Works published elsewhere are a section of their own while the social source is on. It sits before the
 * library sections, which fold under "更多" once the row holds more than fits a phone.
 */
export function siteNav(): NavItem[] {
  const nav: NavItem[] = sections.filter(section => contentFeatures[section.kind]).map(({ href, label, more }) => ({ href, label, more }));
  if (isSocialEnabled()) {
    const firstFoldable = nav.findIndex(item => item.more);
    nav.splice(firstFoldable === -1 ? nav.length : firstFoldable, 0, { href: "/works", label: "作品" });
  }
  return nav;
}
