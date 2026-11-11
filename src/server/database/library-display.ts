import { ContentServiceError } from "../../../contracts/repository.ts";
import type { ImageAsset } from "../../../contracts/content.ts";
import type { Projection } from "./website-repository.ts";
import type { SqlExecutor } from "./sql.ts";

type Delivery = NonNullable<ImageAsset["delivery"]>;
export type DeliveryHints = Map<string, Delivery | null>;
export type PrepareLibraryDelivery = (projection: Projection) => Promise<DeliveryHints>;
const unavailable = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid library display preparation."); };
const isImage = (o: Record<string, unknown>) => typeof o.id === "string" && o.src === "/media/v2/" + o.id;

/** Reuse either existing local-manifest or cloud-mapping projection on selected
 * public metadata only. It receives no content executor and cannot reread items. */
export function createLibraryDisplayPreparation(decorate: (input: SqlExecutor) => SqlExecutor): PrepareLibraryDelivery {
  return async projection => {
    const hints: DeliveryHints = new Map();
    const allowed = new Set(projection.mediaIds);
    let visited = 0;
    function walk(value: unknown, collect: boolean, depth = 0): void {
      if (++visited > 200000 || depth > 64) unavailable();
      if (Array.isArray(value)) { value.forEach(x => walk(x, collect, depth + 1)); return; }
      if (!value || typeof value !== "object") return;
      const obj = value as Record<string, unknown>;
      if (isImage(obj) && allowed.has(obj.id as string)) {
        if (collect) hints.set(obj.id as string, null);
        else if (hints.has(obj.id as string)) hints.set(obj.id as string, (obj.delivery ?? null) as Delivery | null);
      }
      Object.values(obj).forEach(x => walk(x, collect, depth + 1));
    }
    walk(projection.records, true);
    if (!hints.size) return hints;
    const prepared = await decorate({ query: async <T>() => ({ rows: [{ result: projection } as T] }) })
      .query<{ result: Projection }>("library-selected-envelope");
    walk(prepared.rows[0]?.result.records, false);
    return validateDeliveryHints(hints);
  };
}

export function validateDeliveryHints(value: DeliveryHints): DeliveryHints {
  if (!(value instanceof Map) || value.size > 1000) unavailable();
  const out: DeliveryHints = new Map();
  for (const [id, hint] of value) {
    if (!/^a1\.[a-f0-9]{64}$/.test(id)) unavailable();
    if (hint === null) { out.set(id, null); continue; }
    if (!hint || hint.mode !== "display-only" || !Number.isSafeInteger(hint.maxWidth) || hint.maxWidth <= 0 ||
      !Number.isSafeInteger(hint.maxHeight) || hint.maxHeight <= 0) unavailable();
    out.set(id, { mode: "display-only", maxWidth: hint.maxWidth, maxHeight: hint.maxHeight });
  }
  return out;
}

/** Pure attachment after the last authorization SQL. Never reuse prepared DTOs. */
export function applyDeliveryHints<T>(value: T, hints: DeliveryHints): T {
  function visit(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(visit).filter(x => x !== null);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (isImage(o)) {
      if (!hints.has(o.id as string)) throw new ContentServiceError("INVALID_QUERY", "Selected media changed during display preparation.");
      const delivery = hints.get(o.id as string);
      return delivery === null ? null : { ...o, delivery };
    }
    return Object.fromEntries(Object.entries(o).map(([key, x]) => [key, visit(x)]));
  }
  return visit(value) as T;
}
