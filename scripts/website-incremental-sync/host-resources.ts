import { hostFail } from "./host-budget.ts";

export type RegisterHostCleanup = (close: () => void | Promise<void>) => void;

/** Allocation may outlive a cancelled hostAwait. Drain it and its registered
 * resources before releasing the canonical writer lock. */
export function createHostResources() {
  const pending = new Set<Promise<unknown>>(), cleanups: (() => void | Promise<void>)[] = [];
  let phase: "open" | "closing" | "closed" = "open", closing: Promise<void> | undefined;
  const register: RegisterHostCleanup = close => {
    if (phase === "closed" || typeof close !== "function") hostFail("HOST_RESOURCE_CLOSED");
    cleanups.push(close);
  };
  return {
    register,
    open<T>(factory: () => Promise<T>): Promise<T> {
      if (phase !== "open") hostFail("HOST_RESOURCE_CLOSED");
      const result = Promise.resolve().then(factory); pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    },
    close(): Promise<void> {
      if (closing) return closing;
      phase = "closing";
      closing = (async () => {
        await Promise.allSettled([...pending]);
        let failed = false;
        // A pending factory may register its cleanup while close is draining it.
        while (cleanups.length) try { await cleanups.pop()!(); } catch { failed = true; }
        phase = "closed";
        if (failed) hostFail("HOST_RESOURCE_CLOSE_FAILED");
      })();
      return closing;
    },
  };
}
