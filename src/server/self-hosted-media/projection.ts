import type { SqlExecutor } from "../database/sql.ts";
import type { DisplayStore } from "./files.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { displayRunId, displayUnavailable, type DisplayAsset } from "./manifest.ts";

/** Add public delivery hints inside the same already-qualified SQL projection.
 * No extra SQL/Notion reads, stored-record mutation or positive eligibility cache. */
export function displayProjectionSql(db: SqlExecutor, store: DisplayStore): SqlExecutor {
  return { async query<T>(text: string, values?: unknown[]) {
    const result = await db.query<T>(text, values);
    const manifests = new Map<string, Promise<Map<string, DisplayAsset>>>();
    let visited = 0;
    const image = (v: Record<string, unknown>) => typeof v.src === "string" && typeof v.id === "string" && typeof v.alt === "string" && Object.hasOwn(v, "width") && Object.hasOwn(v, "height");
    async function transform(value: unknown, depth = 0): Promise<unknown> {
      if (++visited > 200000 || depth > 64) displayUnavailable();
      if (Array.isArray(value)) return Promise.all(value.map(v => transform(v, depth + 1)));
      if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
      const p = value as Record<string, unknown>;
      if (p.schemaDigest === WEBSITE_SCHEMA_DIGEST && displayRunId(p.runId) && Array.isArray(p.records) && Array.isArray(p.mediaIds)) {
        const allowed = new Set(p.mediaIds);
        let catalog: Map<string, DisplayAsset> | undefined;
        const project = async (v: unknown, level: number): Promise<unknown> => {
          if (++visited > 200000 || level > 64) displayUnavailable();
          if (Array.isArray(v)) return Promise.all(v.map(x => project(x, level + 1)));
          if (!v || typeof v !== "object") return v;
          const o = v as Record<string, unknown>;
          if (image(o)) {
            if (o.src !== "/media/v2/" + o.id || !allowed.has(o.id)) return null;
            if (!catalog) {
              let pending = manifests.get(p.runId as string);
              if (!pending) {
                pending = store.manifest(p.runId as string).then(manifest => new Map(manifest.assets.map(asset => [asset.assetId, asset])));
                manifests.set(p.runId as string, pending);
              }
              catalog = await pending;
            }
            const asset = catalog.get(o.id as string);
            if (!asset) return null;
            return { ...o, delivery: { mode: "display-only", maxWidth: asset.base.width, maxHeight: asset.base.height } };
          }
          return Object.fromEntries(await Promise.all(Object.entries(o).map(async ([k, x]) => [k, await project(x, level + 1)])));
        };
        return { ...p, records: await project(p.records, depth + 1) };
      }
      return Object.fromEntries(await Promise.all(Object.entries(p).map(async ([k, v]) => [k, await transform(v, depth + 1)])));
    }
    return { ...result, rows: await transform(result.rows) as T[] };
  } };
}
