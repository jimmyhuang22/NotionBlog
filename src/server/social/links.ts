import type { SocialPlatform } from "../../../contracts/social.ts";

/** The web-share token comes from Copy link; cookie/session/auth parameters are never accepted. */
export function isVerifiedPlatformUrl(platform: SocialPlatform, publicationId: string, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    if (platform === "bilibili") return /^BV[0-9A-Za-z]{10}$/.test(publicationId) &&
      value === `https://www.bilibili.com/video/${publicationId}/`;
    if (!/^[a-f0-9]{24}$/.test(publicationId) || url.hostname !== "www.xiaohongshu.com" ||
        url.pathname !== `/discovery/item/${publicationId}`) return false;
    return value === `https://www.xiaohongshu.com/discovery/item/${publicationId}?source=webshare&xhsshare=pc_web&xsec_token=${url.searchParams.get("xsec_token")}&xsec_source=pc_share` &&
      /^[A-Za-z0-9_=-]{16,255}$/.test(url.searchParams.get("xsec_token") ?? "");
  } catch { return false; }
}
