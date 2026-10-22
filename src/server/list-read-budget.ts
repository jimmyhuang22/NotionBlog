import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { withContentReadBudget } from "./content-read-budget.ts";
import { ContentServiceError } from "../../contracts/repository.ts";

/** Service deadline leaves room for serialization and the HTTP response; it cannot
 * bound platform dispatch, event-loop stalls or the visitor's network. */
export const LIST_READ_TIMEOUT_MS = 7_000;
const active = new AsyncLocalStorage<boolean>();

/** Both SSR and API use this boundary. Nested API -> repository calls share one
 * deadline and one log; a later SQL call never starts another seven-second window. */
export function withListReadBudget<T>(operation: "works" | "home-feed", read: () => Promise<T>, signal = new AbortController().signal): Promise<T> {
  if (active.getStore()) return read();
  const started = performance.now();
  return active.run(true, async () => {
    let outcome: "ok" | "error" = "error";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => { controller.abort(); reject(new ContentServiceError("CONTENT_UNAVAILABLE", "The list read was cancelled or exceeded its deadline.")); };
      timer = setTimeout(stop, LIST_READ_TIMEOUT_MS);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
    try {
      // Unlike an unguarded Promise.race, cancellation is propagated to every
      // request SQL checkout/query before rejecting. Acquired clients are destroyed;
      // late checkouts are returned without ever sending SQL (request-query.ts).
      const result = await Promise.race([withContentReadBudget(controller.signal, read, { timeoutMs: LIST_READ_TIMEOUT_MS }), cancelled]);
      outcome = "ok";
      return result;
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", stop);
      controller.abort();
      // Vercel attaches the request context. Never log cursors, SQL, identity or exception messages.
      try { console.info("CONTENT_LIST_READ", JSON.stringify({ operation, outcome, durationMs: Math.round(performance.now() - started), limitMs: LIST_READ_TIMEOUT_MS })); } catch { /* preserve provider outcome */ }
    }
  });
}
