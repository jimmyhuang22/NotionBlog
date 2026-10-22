import { createHash } from "node:crypto";

const key = Symbol.for("notionblog.inflight-notion-reads");
const state = globalThis as typeof globalThis & { [key]?: Map<string, Map<string, Promise<unknown>>> };
const connections = state[key] ??= new Map<string, Map<string, Promise<unknown>>>();

/** Share only overlapping reads. Settled results, including denials and errors,
 * are removed before the next qualification check; each caller owns its copy. */
export function inflightNotionRead<T>(token: string, version: string, operation: string, id: string, load: () => Promise<T>): Promise<T> {
  const connection = createHash("sha256").update(JSON.stringify([token, version])).digest("hex");
  let pending = connections.get(connection);
  if (!pending) {
    // Backpressure remains the scheduler's job. Avoid retaining unbounded keys.
    if (connections.size >= 32) return load();
    pending = new Map(); connections.set(connection, pending);
  }
  const identity = `${operation}:${id}`;
  let work = pending.get(identity) as Promise<T> | undefined;
  if (!work) {
    if (pending.size >= 2048) return load();
    const owned = pending;
    work = Promise.resolve().then(load);
    owned.set(identity, work);
    const remove = () => {
      if (owned.get(identity) === work) owned.delete(identity);
      if (!owned.size && connections.get(connection) === owned) connections.delete(connection);
    };
    void work.then(remove, remove);
  }
  return work.then(value => structuredClone(value));
}
