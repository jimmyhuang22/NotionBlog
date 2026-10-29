/**
 * How a link block reads (the note page redesign, 2026-10-21): one line with a small mark, a name and the
 * address without its scheme. Notion gives a bookmark no name of its own, so the source stores the host
 * ("youtu.be") when the author wrote no caption; a video host then reads "YouTube 视频" and any other host
 * its bare name. A caption the author wrote is kept as written.
 */
export interface BookmarkLabel { kind: "video" | "link"; title: string; address: string }

const videoHosts: Record<string, string> = {
  "youtube.com": "YouTube 视频", "youtu.be": "YouTube 视频", "m.youtube.com": "YouTube 视频",
  "bilibili.com": "B 站视频", "b23.tv": "B 站视频", "vimeo.com": "Vimeo 视频",
};

export function bookmarkLabel(url: string, title: string): BookmarkLabel {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { kind: "link", title: title || url, address: url }; }
  const host = parsed.hostname.replace(/^www\./u, "");
  const video = videoHosts[host];
  // A video embed with no caption comes from the source as "视频 · host": that is the source's stand-in, not a name.
  const named = title.trim() !== "" && ![url, parsed.hostname, host, `视频 · ${parsed.hostname}`, `视频 · ${host}`].includes(title.trim());
  const address = `${host}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "")}${parsed.search}`;
  return { kind: video ? "video" : "link", title: named ? title.trim() : video ?? host, address };
}
