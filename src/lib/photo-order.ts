/**
 * The photo the viewer shows for `key`: itself while it is still on the page, else the next one in reading
 * order that is, else the last one before it; nothing when none is left (the viewer then closes).
 */
export function nearestShown(order: readonly string[], key: string, isOnPage: (key: string) => boolean): string | undefined {
  if (isOnPage(key)) return key;
  const at = order.indexOf(key);
  return order.slice(at + 1).find(isOnPage) ?? order.slice(0, Math.max(0, at)).reverse().find(isOnPage);
}
