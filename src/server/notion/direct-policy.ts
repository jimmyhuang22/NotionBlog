import { AsyncLocalStorage } from "node:async_hooks";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";
import { normalizeId } from "./config.ts";

export interface DirectDenials { revision: string; denied: boolean[] }
export type DirectDenyRead = (ids: readonly string[]) => Promise<DirectDenials>;
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The central content policy could not be verified.");

class PolicyScope {
  private revision?: string;
  private calls = 0;
  private bytes = 0;
  private failed: unknown;
  private closed = false;
  private known = new Map<string, Promise<boolean>>();
  private pending = new Map<string, { resolve(value: boolean): void; reject(error: unknown): void }>();
  private scheduled = false;
  private serial = Promise.resolve();
  private read: DirectDenyRead;
  constructor(read: DirectDenyRead) { this.read = read; }
  async query(ids: readonly string[]): Promise<boolean[]> {
    checkContentReadBudget();
    if (this.failed || this.closed || ++this.calls > 64 || ids.length > 256) throw this.failed ?? unavailable();
    try {
      const result = await this.read(ids);
      this.bytes += Buffer.byteLength(JSON.stringify(result));
      if (this.bytes > 256 * 1024 || !result || Object.keys(result).sort().join() !== "denied,revision" ||
          !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(result.revision) || !Array.isArray(result.denied) ||
          result.denied.length !== ids.length || result.denied.some(v => typeof v !== "boolean") ||
          (this.revision !== undefined && result.revision !== this.revision)) throw unavailable();
      this.revision ??= result.revision;
      checkContentReadBudget();
      return result.denied;
    } catch (error) { this.failed = error; throw error; }
  }
  denied(id: string): Promise<boolean> {
    const key = normalizeId(id);
    const old = this.known.get(key); if (old) return old;
    const promise = new Promise<boolean>((resolve, reject) => { this.pending.set(key, { resolve, reject }); });
    this.known.set(key, promise);
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => this.flush()); }
    return promise;
  }
  private flush() {
    this.scheduled = false;
    const entries = [...this.pending]; this.pending.clear();
    this.serial = this.serial.then(async () => {
      for (let start = 0; start < entries.length; start += 256) {
        const chunk = entries.slice(start, start + 256);
        try { const values = await this.query(chunk.map(([id]) => id)); chunk.forEach(([, port], i) => port.resolve(values[i])); }
        catch (error) { entries.slice(start).forEach(([, port]) => port.reject(error)); return; }
      }
    });
  }
  async close() { this.closed = true; await this.serial; }
}
const scopes = new AsyncLocalStorage<PolicyScope>();

/** No scope is installed for sync workers or the database/hybrid provider. */
export const directPageDenied = (id: string): Promise<boolean> => scopes.getStore()?.denied(id) ?? Promise.resolve(false);
export async function primeDirectDenials(ids: readonly string[]): Promise<void> {
  if (scopes.getStore()) await Promise.all([...new Set(ids)].map(directPageDenied));
}
export async function verifyDirectPolicy(): Promise<void> { await scopes.getStore()?.query([]); }

/** A complete public operation shares one policy version, even through nested repository calls. */
export async function withDirectPolicy<T>(factory: () => DirectDenyRead, read: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) return read();
  if (!contentReadBudgetIdentity()) return withContentReadBudget(AbortSignal.timeout(30_000), () => withDirectPolicy(factory, read));
  const scope = new PolicyScope(factory());
  return scopes.run(scope, async () => {
    try { await scope.query([]); const result = await read(); await scope.query([]); return result; }
    finally { await scope.close(); }
  });
}
export function directPolicyRepository<T extends object>(repository: T, factory: () => DirectDenyRead): T {
  return new Proxy(repository, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === "function" ? (...args: unknown[]) => withDirectPolicy(factory, () => Reflect.apply(value, receiver, args)) : value;
  } });
}
