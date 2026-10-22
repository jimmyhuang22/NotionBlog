import type { SocialLink } from "@/lib/site/parse";
import { socialIconPaths } from "./social-icon-paths";

const WORD_MARKS: ReadonlySet<SocialLink["platform"]> = new Set(["xiaohongshu"]);

function Icon({ platform }: { platform: SocialLink["platform"] }) {
  if (platform === "email") {
    return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2.5" /><path d="m3.5 6.5 6.5 4.5 6.5-4.5" /></svg>;
  }
  if (platform === "link") {
    return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.6-2.6a3.2 3.2 0 0 0-4.5-4.5l-.9.9" /><path d="M11.5 8.5a3.2 3.2 0 0 0-4.5 0l-2.6 2.6a3.2 3.2 0 0 0 4.5 4.5l.9-.9" /></svg>;
  }
  // Most marks are compact glyphs; a word mark only fills a band of its box, so it is set larger to carry the same weight.
  const size = WORD_MARKS.has(platform) ? 30 : 20;
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d={socialIconPaths[platform]} /></svg>;
}

export function SocialLinks({ links }: { links: SocialLink[] }) {
  if (!links.length) return null;
  return (
    <ul className="socials" aria-label="社交媒体">
      {links.map(link => (
        <li key={`${link.platform}:${link.url}`}>
          <a href={link.url} target="_blank" rel="noopener noreferrer me" aria-label={link.label} title={link.label} data-platform={link.platform}><Icon platform={link.platform} /></a>
        </li>
      ))}
    </ul>
  );
}
