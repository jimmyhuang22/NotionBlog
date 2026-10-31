/**
 * The content service hides the name of a page that is not public, and the kind of a block it cannot
 * carry, behind fixed English placeholders. They are not content: a visitor reads them in the page's
 * own language. Anything else the service sends is shown as it is.
 */
const HIDDEN_PAGE = "Unavailable page";
const UNSUPPORTED_BLOCK = "Unsupported Notion block";
/** A collapsible heading arrives as the heading and a toggle the source names `<id>-content` and titles "Details". */
const COLLAPSED_HEADING = "Details";

/** The name to show for a page that is not open to visitors. */
export function hiddenPageLabel(title: string): string {
  return !title.trim() || title === HIDDEN_PAGE ? "未开放的页面" : title;
}

/**
 * What to add in brackets after "this part cannot be shown". The service explains its own limits in fixed English
 * ("Nested content is not supported for this block", "Image unavailable" …), which is not for visitors (S15-3,
 * 2026-10-31), so only a label in the page's language is kept.
 */
export function unsupportedDetail(label: string): string | null {
  return !label.trim() || label === UNSUPPORTED_BLOCK || !/[\u3400-\u9fff]/.test(label) ? null : label;
}

/** What a collapsible heading's own fold says: the source's fixed English title, read in the page's language. */
export function foldSummary(blockId: string, title: string): string | null {
  return blockId.endsWith("-content") && title.trim() === COLLAPSED_HEADING ? "展开内容" : null;
}
