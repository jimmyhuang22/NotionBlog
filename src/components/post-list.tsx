"use client";

import Link from "next/link";
import type { Page, Post } from "../../contracts/content.ts";
import { postGroups } from "../lib/post-groups.ts";
import { CoverImage } from "./cover-image";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";

export function PostList({ initial, pageSize, tag, timeZone }: { initial: Page<Post>; pageSize: number; tag: string | null; timeZone: string }) {
  const query: Record<string, string> = { limit: String(pageSize), ...(tag ? { tag } : {}) };
  const { items, restarted, total, paged, ...paging } = usePagedList<Post>("/api/content/post", query, initial);
  if (!items.length) return <div className="state"><p>{tag ? "这个标签下还没有文章。" : "还没有文章。"}</p></div>;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 20 }}>文章列表有更新，已从头重新加载。</p> : null}
      {postGroups(items, timeZone).map(group => (
        <section key={`${group.key}:${group.items[0]?.post.id}`} className="posts__group">
          {group.label ? <h2 className="section-title posts__year">{group.label}</h2> : null}
          {group.items.map(({ post, day }) => (
            <article key={post.id} className="card post-card">
              <div className="post-card__text">
                {day ? <time className="post-card__date" dateTime={post.publishedAt?.start}>{day}</time> : null}
                <h3 className="post-card__title"><Link href={post.href} prefetch={false}>{post.title}</Link></h3>
                {post.summary ? <p className="post-card__summary">{post.summary}</p> : null}
                {post.tags.length ? (
                  <p className="post-card__tags">
                    {post.tags.map(name => <Link key={name} className="tag" href={`/blog?tag=${encodeURIComponent(name)}`} prefetch={false}>{name}</Link>)}
                  </p>
                ) : null}
              </div>
              {/* Covers use the re-authorised media path directly, without an optimiser cache. One that cannot be read leaves the card as it is without a cover. */}
              {post.cover ? <CoverImage className="post-card__cover" image={post.cover} previewWidth={400} label="文章封面" lazy sized={false} fallback={null} /> : null}
            </article>
          ))}
        </section>
      ))}
      {paged ? <ListTail className="library__more" paging={paging} label="加载更早的文章" status={pagingMessage(paging.problem, items.length, "篇", total)} /> : null}
    </>
  );
}
