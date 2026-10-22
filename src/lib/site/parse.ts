import type { StudyProjectDefinition } from "../../../contracts/study.ts";
import { parseStudyProjects } from "../study-projects.ts";

/** Site identity shown in the shell and on the home page. Real values live in private configuration. */
export const SOCIAL_PLATFORMS = ["bilibili", "xiaohongshu", "steam", "github", "email", "link"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialLink {
  platform: SocialPlatform;
  label: string;
  url: string;
}
export interface SiteConfig {
  siteName: string;
  /** Optional public source-site shortcut in the footer. Real URLs stay in private configuration. */
  notionSiteUrl?: string;
  /** IANA zone used to render datetimes identically on the server and in the browser. */
  timeZone: string;
  profile: {
    name: string | null;
    bio: string | null;
    /** Root-relative path under public/ or an https URL. null renders the monogram. */
    avatar: string | null;
  };
  socials: SocialLink[];
  studyProjects?: StudyProjectDefinition[];
}

const platformLabels: Record<SocialPlatform, string> = {
  bilibili: "哔哩哔哩",
  xiaohongshu: "小红书",
  steam: "Steam",
  github: "GitHub",
  email: "邮箱",
  link: "链接",
};

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function timeZone(value: unknown): string | null {
  const zone = text(value, 64);
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function avatar(value: unknown): string | null {
  const source = text(value, 2048);
  if (!source) return null;
  if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\")) return source;
  return httpsUrl(source);
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function social(value: unknown): SocialLink | null {
  const input = record(value);
  const platform = SOCIAL_PLATFORMS.find((candidate) => candidate === input.platform);
  const rawUrl = text(input.url, 2048);
  if (!platform || !rawUrl) return null;
  const url = platform === "email" && /^mailto:[^\s@]+@[^\s@]+$/u.test(rawUrl) ? rawUrl : httpsUrl(rawUrl);
  if (!url) return null;
  return { platform, url, label: text(input.label, 40) ?? platformLabels[platform] };
}

/** Lenient by design: an invalid field falls back so a config mistake never takes the site down. */
export function parseSiteConfig(input: unknown, fallbackName = "NotionBlog"): SiteConfig {
  const source = record(input);
  const profile = record(source.profile);
  const socials = Array.isArray(source.socials) ? source.socials.slice(0, 12) : [];
  const sourceUrl = text(source.notionSiteUrl, 2048);
  const notionSiteUrl = sourceUrl ? httpsUrl(sourceUrl) : null;
  return {
    siteName: text(source.siteName, 60) ?? text(fallbackName, 60) ?? "NotionBlog",
    ...(notionSiteUrl ? { notionSiteUrl } : {}),
    timeZone: timeZone(source.timeZone) ?? "UTC",
    profile: {
      name: text(profile.name, 60),
      bio: text(profile.bio, 200),
      avatar: avatar(profile.avatar),
    },
    socials: socials.map(social).filter((link): link is SocialLink => link !== null),
    ...(source.studyProjects !== undefined ? { studyProjects: parseStudyProjects(source.studyProjects) } : {}),
  };
}
