/**
 * The island skin's rounded heading face (寒蝉全圆体, skins.css). Its declarations, one per slice of the face,
 * run to some 120 KB, so they are not part of the site's stylesheet: theme-toggle.tsx imports this module when
 * the island is in use, and the browser fetches the slices a page's headings need from there.
 */
import "@chinese-fonts/hcqyt/dist/ChillRoundFBold/result.css";

export {};
