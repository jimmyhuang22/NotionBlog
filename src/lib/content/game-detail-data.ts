/** Canonical Bilibili links from the owner's URL field. No external redirects are followed. */
export function gamePlayVideoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) return null;
  const video = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  if (video && ["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(url.hostname)) {
    return `https://www.bilibili.com/video/${video[1]}/`;
  }
  const season = /^\/([1-9][0-9]{0,19})\/lists\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname);
  const type = url.searchParams.getAll("type");
  if (season && url.hostname === "space.bilibili.com" && (type.length === 0 || type.length === 1 && type[0] === "season")) {
    return `https://space.bilibili.com/${season[1]}/lists/${season[2]}?type=season`;
  }
  if (url.hostname === "b23.tv" && /^\/[A-Za-z0-9]{4,20}\/?$/.test(url.pathname)) return `https://b23.tv${url.pathname}`;
  return null;
}
