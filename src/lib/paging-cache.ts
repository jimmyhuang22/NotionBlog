import type { Page } from "../../contracts/content.ts";

/** A fresh server page must agree in full, including cursor context and totals. */
export const initialPageIdentity = <T>(page: Page<T>) => JSON.stringify(page);
export function canRestoreList(snapshot: { address: string; initialPage: string } | undefined,
  currentAddress: string, traversedTo: string | null, initialPage: string, reuseOnNavigation: boolean): boolean {
  if (!snapshot || snapshot.address !== currentAddress) return false;
  if (reuseOnNavigation) return snapshot.initialPage === initialPage;
  return traversedTo === currentAddress;
}
