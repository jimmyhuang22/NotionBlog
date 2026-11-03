/** Public section labels only; detail eligibility and content still come from the server. */
const titles: Readonly<Record<string, string>> = {
  "/status": "动态", "/study": "学习", "/works": "作品",
  "/library/movies": "影视", "/library/books": "书籍", "/library/games": "游戏",
  "/photos": "相册", "/blog": "博客", "/projects": "项目",
  "/search": "搜索", "/about": "关于",
};

/** Exact section roots: filters share a path; nested notes/details keep their own transitions. */
export function sectionLoadingTitle(pathname: string | null): string | undefined {
  return pathname !== null && Object.hasOwn(titles, pathname) ? titles[pathname] : undefined;
}
