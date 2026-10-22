import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { sourceFingerprint } from "../../src/server/media/notion-source.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { WorkerError } from "../notion-sync/errors.ts";

const methods = ["getPage", "getBlock", "getDataSource", "getDatabase", "listBlocks", "listPages"] as const;
type Method = typeof methods[number];
export interface SourceReadProof {
  method: Method; id: string; digest: string; requestUpperBound: number;
  /** Absent means the original raw-response digest; never reinterpret it as v2. */
  digestVersion?: 2;
}
export function validateSourceReadProof(value: SourceReadProof[]) {
  if (!Array.isArray(value) || !value.length || value.length > 30_000 || new Set(value.map(p => `${p.method}:${p.id}`)).size !== value.length ||
      value.some(p => !methods.includes(p.method) || normalizeId(p.id) !== p.id || !/^[a-f0-9]{64}$/.test(p.digest) ||
        (p.digestVersion !== undefined && p.digestVersion !== 2) ||
        !Number.isSafeInteger(p.requestUpperBound) || p.requestUpperBound < 1 || p.requestUpperBound > 30_000)) throw new WorkerError("CHECKPOINT_FAILED");
}
// Signed delivery URLs rotate without changing the source object. Everything
// else (including block text/children, properties, parent and archive) is hashed.
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  if (o.type === "file" && o.file && typeof o.file === "object") {
    const file = o.file as Record<string, unknown>;
    if (typeof file.url === "string") return { ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "file").map(([k, v]) => [k, stable(v)])),
      file: { ...Object.fromEntries(Object.entries(file).filter(([k]) => k !== "url" && k !== "expiry_time")), fingerprint: sourceFingerprint(file.url, true) } };
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stable(v)]));
}

// The SDK returns request_id on retrieved entities, but not necessarily on
// entities seeded from a complete listing. It identifies the HTTP response,
// not the Notion content. Remove it ONLY at each returned entity's root:
// properties named request_id and nested content must remain in the digest.
function contentResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entityResponse);
  return entityResponse(value);
}
function entityResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "request_id"));
}
function responseDigest(value: unknown, version?: 2): string {
  return configDigest(stable(version === 2 ? contentResponse(value) : value));
}

/** One collection only. Never loads old responses: every cached value was read
 * from the current client during this attempt. End-of-page owner checks bypass
 * this memo. Old checkpoints contain hashes, never these raw objects/URLs. */
export function createCollectionReadSession(source: NotionReadClient, guard: () => void) {
  const entries = new Map<string, Promise<unknown>>();
  const fulfilled = new Set<string>();
  let bytes = 0, calls = 0, hits = 0;
  async function read(method: Method, id: string) {
    guard(); id = normalizeId(id); const key = `${method}:${id}`;
    const fn = source[method] as ((id: string) => Promise<unknown>) | undefined; if (!fn) throw new WorkerError("MISCONFIGURED");
    if (!entries.has(key)) {
      if (entries.size >= 30_000) throw new WorkerError("LIMIT_EXCEEDED");
      calls++;
      entries.set(key, Promise.resolve().then(() => fn.call(source, id)).then(value => {
        guard(); bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > 256 * 1024 * 1024) throw new WorkerError("LIMIT_EXCEEDED");
        // Complete listings also prove their returned entities; avoid one extra
        // GET for each image/ancestor already present in the fresh traversal.
        if (method === "listBlocks" || method === "listPages") for (const item of value as { id: string; type?: string; has_children?: boolean }[]) {
          if (method === "listBlocks" && item.type !== "image" && !item.has_children) continue;
          const child = `${method === "listBlocks" ? "getBlock" : "getPage"}:${normalizeId(item.id)}`;
          if (!entries.has(child)) {
            if (entries.size >= 30_000) throw new WorkerError("LIMIT_EXCEEDED");
            entries.set(child, Promise.resolve(structuredClone(item)));
            fulfilled.add(child);
          }
        }
        fulfilled.add(key);
        return structuredClone(value);
      }));
    } else hits++;
    const value = await entries.get(key); guard(); return structuredClone(value);
  }
  function client(record?: Map<string, SourceReadProof>): NotionReadClient {
    return Object.fromEntries(methods.filter(m => source[m]).map(method => [method, async (id: string) => {
      const value = await read(method, id);
      if (record) record.set(`${method}:${normalizeId(id)}`, { method, id: normalizeId(id), digestVersion: 2, digest: responseDigest(value, 2),
        // Lists use page_size=100; include the possible final pagination call.
        requestUpperBound: Array.isArray(value) ? Math.floor(value.length / 100) + 1 : 1 });
      return value;
    }])) as unknown as NotionReadClient;
  }
  return {
    client: client(),
    /** Only successful reads in this live session reduce future request work.
     * Old proofs, pending calls and rejected calls never grant this credit. */
    pendingProofRequests(proofs: SourceReadProof[][]): number {
      guard(); const pending = new Map<string, number>();
      for (const proof of proofs) {
        validateSourceReadProof(proof);
        for (const item of proof) {
          const key = `${item.method}:${item.id}`;
          if (!fulfilled.has(key)) pending.set(key, Math.max(pending.get(key) ?? 0, item.requestUpperBound));
        }
      }
      return [...pending.values()].reduce((sum, count) => sum + count, 0);
    },
    trace() {
      const proof = new Map<string, SourceReadProof>();
      return { client: client(proof), seal: () => { const result = [...proof.values()]; validateSourceReadProof(result); return result; } };
    },
    async matches(proof: SourceReadProof[]) {
      validateSourceReadProof(proof);
      for (const item of proof) if (responseDigest(await read(item.method, item.id), item.digestVersion) !== item.digest) return false;
      return true;
    },
    statistics: () => ({ calls, memoHits: hits, responseBytes: bytes, cachedReads: entries.size }),
  };
}
