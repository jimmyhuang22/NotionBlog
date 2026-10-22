export interface NavItem { href: string; label: string; more?: boolean }

/** The most sections the header row holds at phone widths in every skin; see docs/FRONTEND_GUIDE.md. */
export const NAV_ROW_LIMIT = 6;

/** Whether a pathname is the section's own page or one beneath it. */
export function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Splits the enabled sections into the ones shown in the header row and the ones folded under "更多".
 * Everything stays in the row while it fits; past that the foldable sections move under the menu.
 * A single foldable section stays in the row: a menu with one entry would only add a click.
 */
export function splitNav(items: NavItem[]): { primary: NavItem[]; more: NavItem[] } {
  const foldable = items.filter(item => item.more);
  if (items.length <= NAV_ROW_LIMIT || foldable.length < 2) return { primary: items, more: [] };
  return { primary: items.filter(item => !item.more), more: foldable };
}
