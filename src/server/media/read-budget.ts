import { contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";

/** A cancelled image cannot keep acquiring SQL clients or reading objects for another visitor. */
export function withMediaReadBudget<T>(signal: AbortSignal, read: () => Promise<T>, timeoutMs = 8_000): Promise<T> {
  if (contentReadBudgetIdentity()) return read();
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new ContentServiceError("CONTENT_UNAVAILABLE", "The image read was cancelled or exceeded its deadline."));
    combined.addEventListener("abort", stop, { once: true });
    if (combined.aborted) stop();
  });
  return Promise.race([withContentReadBudget(combined, read, { timeoutMs }), cancelled])
    .finally(() => combined.removeEventListener("abort", stop));
}
