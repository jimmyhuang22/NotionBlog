import { socialIconPaths } from "./social-icon-paths";

/**
 * Each platform's own icon in its own colour, whatever the theme: Bilibili's television in its blue,
 * Xiaohongshu's red app tile with its white word mark (its mark is a word, so beside the name it would
 * read twice). Used by the works page and its loading state.
 */
export function WorksPlatformIcon({ platform }: { platform: "bilibili" | "xiaohongshu" }) {
  if (platform === "bilibili") return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="#00a1d6"><path d={socialIconPaths.bilibili} /></svg>;
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="6" fill="#ff2442" />
      <path d={socialIconPaths.xiaohongshu} fill="#fff" transform="translate(2.5 7.25) scale(0.79) translate(0 -6)" />
    </svg>
  );
}
