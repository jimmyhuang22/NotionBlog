/**
 * The content service hides the name of a page that is not public, and the kind of a block it cannot
 * carry, behind fixed English placeholders. They are not content: a visitor reads them in the page's
 * own language. Anything else the service sends is shown as it is.
 */
const HIDDEN_PAGE = "Unavailable page";
const UNSUPPORTED_BLOCK = "Unsupported Notion block";

/** The name to show for a page that is not open to visitors. */
export function hiddenPageLabel(title: string): string {
  return !title.trim() || title === HIDDEN_PAGE ? "未开放的页面" : title;
}

/** What to add in brackets after "this part cannot be shown"; nothing when the service only says so in general. */
export function unsupportedDetail(label: string): string | null {
  return !label.trim() || label === UNSUPPORTED_BLOCK ? null : label;
}
