import type { ContentByKind, ContentDocument, ContentKind, CourseTree, DateRange } from "../contracts/content.ts";

/** Deterministic fictional coverage. No external fetch, private source or generated timestamps. */
export function expandFixtures(items: { [K in ContentKind]: ContentByKind[K][] }, documents: Record<string, ContentDocument>, trees: Record<string, CourseTree>): void {
  const date = (i: number): DateRange => ({ start: `${i % 2 ? 2025 : 2026}-${String(1 + i % 8).padStart(2, "0")}-${String(1 + i % 27).padStart(2, "0")}`, end: null, precision: "date" });
  const base = (id: string, href: string, i: number) => ({ id, slug: id, href, title: `[演示] ${i === 11 ? "用于验证换行与布局的一个很长很长的虚构标题，正文和真实来源无关" : `虚构记录 ${String(i).padStart(2, "0")}`}`, summary: i % 3 ? "虚构内容，用于分页与排序演练。" : null, tags: i % 2 ? ["演练"] : [], cover: null, updatedAt: null });
  const image = (id: string) => ({ id, src: "/mock-media/landscape.svg", alt: "虚构示意图", width: 1200, height: 800 });
  for (let i = 1; i <= 34; i++) {
    const id = `mock-status-extra-${i}`;
    const text = i % 7 === 0 ? [] : [{ text: i % 4 === 0 ? "这是用于验证长正文的虚构动态。".repeat(35) : `虚构动态 ${i}。` }];
    items.status.push({ ...base(id, `/status#${id}`, i), kind: "status", recordedAt: i % 10 === 0 ? null : date(i), text });
    if (i % 5 === 0) continue;
    const blocks: ContentDocument["blocks"] = text.length ? [{ id: `${id}-p`, type: "paragraph", text }] : [];
    if (i % 3 === 0) for (let j = 0; j < (i % 2 ? 1 : 6); j++) blocks.push({ id: `${id}-b${j}`, type: "image", image: image(`${id}-i${j}`), caption: [] });
    if (i === 1) blocks.push({ id: `${id}-code`, type: "code", language: "typescript", code: "const answer = 42;", caption: [] }, { id: `${id}-math`, type: "equation", expression: "E=mc^2" }, { id: `${id}-inline`, type: "paragraph", text: [{ text: "行内表达式：" }, { text: "a^2+b^2=c^2", equation: true }] });
    documents[id] = { blocks, toc: [], completeness: "complete" };
  }
  for (let i = 1; i <= 15; i++) {
    const id = `mock-post-extra-${i}`;
    items.post.push({ ...base(id, `/blog/${id}`, i), kind: "post", publishedAt: i === 15 ? null : date(i) });
    if (i % 3) documents[id] = { blocks: [{ id: `${id}-p`, type: "paragraph", text: [{ text: `虚构文章 ${i}：搜索和相邻文章演练。` }] }], toc: [], completeness: "complete" };
  }
  for (let i = 1; i <= 26; i++) {
    const book = `mock-book-extra-${i}`, movie = `mock-movie-extra-${i}`, game = `mock-game-extra-${i}`;
    items.book.push({ ...base(book, `/library/books/${book}`, i), kind: "book", authors: ["虚构作者"], status: (["read", "reading", "wishlist", "given-up"] as const)[i % 4]!, readingDate: i % 5 ? date(i) : null, pagesRead: null, totalPages: null, progressPercent: null, personalRating: null, doubanRating: null, externalUrl: null });
    items.movie.push({ ...base(movie, `/library/movies/${movie}`, i), kind: "movie", originalTitle: null, mediaType: "动画", status: i % 3 ? "watched" : "wishlist", watchedDate: i % 5 ? date(i) : null, releaseDate: null, director: null, actors: [], rating: null, doubanRating: null });
    items.game.push({ ...base(game, `/library/games/${game}`, i), kind: "game", status: (["clear", "playing", "wishlist", "platinumed"] as const)[i % 4]!, platforms: ["Demo Console"], playedDate: i % 5 ? date(i) : null, releaseDate: null, playedTime: i % 4 ? { value: i * 15, unit: "minute" } : null, estimatedTime: null, progressPercent: null, rating: null });
    if (i < 15) { const id = `mock-album-extra-${i}`; items.album.push({ ...base(id, `/photos/${id}`, i), kind: "album", date: i % 5 ? date(i) : null, photoCount: null }); }
  }
  const gallery = items.album.find(x => x.id === "mock-album-extra-1")!;
  gallery.photoCount = 12;
  documents[gallery.id] = { blocks: [{ id: "demo-gallery-heading", type: "heading", level: 3, text: [{ text: "[演示] 十二张图片" }] }, ...Array.from({ length: 8 }, (_, i) => ({ id: `gallery-image-${i}`, type: "image" as const, image: image(`gallery-asset-${i}`), caption: [] })), { id: "gallery-columns", type: "columns", columns: [0, 1].map(column => ({ ratio: 1, blocks: [0, 1].map(i => ({ id: `gallery-col-${column}-${i}`, type: "image", image: image(`gallery-col-asset-${column}-${i}`), caption: [] })) })) }], toc: [{ id: "demo-gallery-heading", title: "[演示] 十二张图片", level: 3 }], completeness: "complete" };
  documents["mock-about"] = { blocks: [{ id: "demo-about-p", type: "paragraph", text: [{ text: "[演示] 这是一页虚构的关于内容，用于布局与读取入口联调。" }] }], toc: [], completeness: "complete" };
  documents["mock-project-1"] = { blocks: [{ id: "demo-project-p", type: "paragraph", text: [{ text: "[演示] 项目说明与实现过程。" }] }], toc: [], completeness: "complete" };
  for (let i = 0; i < 2; i++) {
    const id = `mock-note-blocks-${i}`;
    items["study-note"].push({ ...base(id, `/study/demo101/notes/${id}`, i), kind: "study-note", courseId: "mock-course-demo101", parentId: null, noteType: "note", date: null, breadcrumbs: [{ title: "DEMO101", href: "/study/demo101" }] });
    const document = structuredClone(documents["mock-post-1"]!);
    if (i) for (const block of document.blocks) if (block.type === "heading") block.level = 3;
    documents[id] = document;
    trees["mock-course-demo101"]!.nodes.push({ id, title: items["study-note"].at(-1)!.title, href: `/study/demo101/notes/${id}`, hasChildren: false, children: [] });
  }
  // Identical titles distinguish course and physical-parent context in both search UIs.
  for (const [index, parentId] of ["mock-note-week4", "mock-note-knowledge", "mock-note-workshop"].entries()) {
    const parent = items["study-note"].find(note => note.id === parentId)!;
    const course = items.course.find(course => course.id === parent.courseId)!;
    const id = `mock-note-introduction-${index}`, href = `/study/${course.slug}/notes/${id}`;
    const note = { ...parent, id, slug: id, href, title: "[演示] Introduction", summary: null, date: null,
      noteType: "note" as const, parentId, breadcrumbs: [...parent.breadcrumbs, { title: parent.title, href: parent.href }] };
    items["study-note"].push(note);
    documents[id] = { blocks: [{ id: `${id}-p`, type: "paragraph", text: [{ text: "Fictional introduction for navigation examples." }] }], toc: [], completeness: "complete" };
    const attach = (nodes: CourseTree["nodes"]): boolean => {
      for (const node of nodes) {
        if (node.id === parentId) { node.hasChildren = true; (node.children ??= []).push({ id, title: note.title, href, hasChildren: false, children: [] }); return true; }
        if (node.children && attach(node.children)) return true;
      }
      return false;
    };
    attach(trees[course.id]!.nodes);
  }

}
