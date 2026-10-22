import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SocialTimelineRepository } from "../../../contracts/social-timeline.ts";
import { checkContentReadBudget, contentReadBudgetIdentity, type ReadBudget } from "../content-read-budget.ts";
import { validateSocialWorksQuery } from "../../lib/content/social-works-query.ts";

const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The works read was cancelled or exceeded its deadline.");

/** Admit a complete works read at a time for each existing pool slot. Otherwise
 * simultaneous requests rejoin pg's FIFO queue at every qualification/query step
 * and can all expire before any request finishes. No result or eligibility cache. */
export function createSocialReadQueue(capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid social read capacity.");
  let active = 0;
  const pending: Array<{ start(): void }> = [];
  const remaining = (budget: ReadBudget) => Math.max(0, Math.floor(budget.deadline - budget.now()));
  const drain = () => { while (active < capacity && pending.length) pending.shift()!.start(); };

  function enter(budget: ReadBudget): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let waiting = true, timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); budget.signal.removeEventListener("abort", cancel); };
      const cancel = () => {
        if (!waiting) return;
        waiting = false; cleanup();
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
        try { console.warn("SOCIAL_READ_QUEUE_FAILURE", JSON.stringify({
          reason: budget.signal.aborted ? "aborted" : "deadline", capacity, active, waiting: pending.length,
        })); } catch { /* preserve the read failure */ }
        reject(unavailable());
      };
      const entry = { start() {
        if (!waiting) return;
        if (budget.signal.aborted || remaining(budget) === 0) { cancel(); return; }
        waiting = false; cleanup(); active++;
        let released = false;
        resolve(() => { if (!released) { released = true; active--; drain(); } });
      } };
      timer = setTimeout(cancel, Math.max(1, remaining(budget)));
      budget.signal.addEventListener("abort", cancel, { once: true });
      if (budget.signal.aborted || remaining(budget) === 0) { cancel(); return; }
      if (active < capacity) entry.start(); else pending.push(entry);
    });
  }

  return { async run<T>(read: () => Promise<T>): Promise<T> {
    const budget = contentReadBudgetIdentity();
    // Frozen/unbudgeted callers retain their existing path.
    if (!budget) return read();
    const release = await enter(budget);
    try { checkContentReadBudget(); return await read(); }
    // Retain the turn until the active read drains, including cancellation cleanup.
    finally { release(); }
  } };
}

export function queueSocialWorksRepository(repository: SocialTimelineRepository, queue: ReturnType<typeof createSocialReadQueue>): SocialTimelineRepository {
  return { async listWorks(query = {}) {
    validateSocialWorksQuery(query);
    return queue.run(() => repository.listWorks(query));
  } };
}
