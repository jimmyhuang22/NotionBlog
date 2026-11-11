import type { StoredMedia } from "../../../contracts/sync.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { checkContentReadBudget, contentReadBudgetIdentity } from "../content-read-budget.ts";

/** Request-owned object reads inherit the media deadline; writer reads do not. */
export async function readMediaObject(storage: Pick<ObjectStorage, "read">, media: StoredMedia): Promise<Uint8Array> {
  checkContentReadBudget();
  const bytes = await storage.read(media, contentReadBudgetIdentity()?.signal);
  checkContentReadBudget();
  return bytes;
}
