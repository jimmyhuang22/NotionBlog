import Link from "next/link";
import type { LibraryKind } from "../../contracts/content.ts";
import { contentRepository } from "../lib/content";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { siteNav } from "../lib/site-nav.ts";
import { statusLabel, type LibraryItem } from "../lib/library.ts";
import { isEnabledContentKind } from "../../config/features.ts";
import { SectionLinks } from "./site-ways";

const KINDS: [LibraryKind, string][] = [["movie", "影视"], ["book", "书籍"], ["game", "游戏"]];

/** The newest work of a shelf that is not only wished for; a shelf that cannot be read is left out, not shown as failed. */
async function latest(kind: LibraryKind): Promise<LibraryItem | null> {
  try {
    const page = await contentRepository.list(kind, { limit: 6 });
    return (page.items as LibraryItem[]).find(item => item.status !== "wishlist") ?? null;
  } catch {
    return null;
  }
}

/**
 * The search page before anything is typed (2026-11-19): the newest film, book and game the owner got to, and
 * every section, so the page offers somewhere to go rather than a field over an empty screen.
 */
export async function SearchStart() {
  const shelves = KINDS.filter(([kind]) => isEnabledContentKind(kind));
  const works = (await Promise.all(shelves.map(async ([kind, label]) => ({ label, item: await latest(kind) })))).filter((entry): entry is { label: string; item: LibraryItem } => !!entry.item);
  return (
    <div className="search-start">
      {works.length ? (
        <section aria-labelledby="search-start-recent">
          <h2 id="search-start-recent" className="search-start__title">最近看过、读过、玩过的</h2>
          <ul className="search-start__works">
            {works.map(({ label, item }) => (
              <li key={item.id}>
                <Link className="search-start__work" href={item.href} prefetch={false}>
                  <span className={`search-start__thumb search-start__thumb--${item.kind}`} aria-hidden="true">{item.cover ? <img src={imagePreviewSrc(item.cover, 400)} alt="" loading="lazy" decoding="async" /> : null}</span>
                  <span className="search-start__text"><span className="search-start__name">{item.title}</span><span className="search-start__kind">{label} · {statusLabel(item)}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="search-start-sections">
        <h2 id="search-start-sections" className="search-start__title">按栏目浏览</h2>
        <SectionLinks items={siteNav()} label="栏目" />
      </section>
    </div>
  );
}
