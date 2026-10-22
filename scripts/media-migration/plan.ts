/** Offline inventory arithmetic only. Never grants publication or performs migration. */
export interface MigrationBlob { sha256: string; byteSize: number }
export interface MigrationAsset {
  sourceKey: string;
  reference: "current" | "historical" | "unreviewed";
  original: MigrationBlob;
  candidate: MigrationBlob;
}
export interface MigrationInventory {
  format: "media-migration-inventory-v1";
  assets: MigrationAsset[];
  retiredSourceKeys: string[];
  protectedSourceKeys: string[];
  limits: { storageAvailableBytes: number | null; transferBudgetBytes: number | null };
}
const MAX_ASSETS = 20000, RUNTIME_IMAGE_LIMIT = 20 * 1024 * 1024;
export class MigrationPlanError extends Error {
  readonly code = "MEDIA_MIGRATION_INPUT_INVALID";
  constructor() { super("Media migration planning failed. Check the private inventory."); }
}
function fail(): never { throw new MigrationPlanError(); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail();
  return value as Record<string, unknown>;
}
function key(value: unknown): value is string {
  // Opaque legacy identities, never used as file paths or network addresses.
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function blob(value: unknown): MigrationBlob {
  const b = object(value, ["sha256", "byteSize"]);
  if (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256) || !count(b.byteSize) || b.byteSize < 1 || b.byteSize > 1024 ** 3) fail();
  return { sha256: b.sha256, byteSize: b.byteSize };
}
function keySet(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length > MAX_ASSETS || !value.every(key) || new Set(value).size !== value.length) fail();
  return new Set(value);
}
function add(a: number, b: number) { const total = a + b; if (!Number.isSafeInteger(total)) fail(); return total; }

export function planMediaMigration(input: unknown) {
  const v = object(input, ["format", "assets", "retiredSourceKeys", "protectedSourceKeys", "limits"]);
  if (v.format !== "media-migration-inventory-v1" || !Array.isArray(v.assets) || v.assets.length > MAX_ASSETS) fail();
  const retired = keySet(v.retiredSourceKeys), protectedKeys = keySet(v.protectedSourceKeys);
  if ([...protectedKeys].some(k => retired.has(k))) fail();
  const limits = object(v.limits, ["storageAvailableBytes", "transferBudgetBytes"]);
  for (const n of Object.values(limits)) if (n !== null && !count(n)) fail();
  const assets: MigrationAsset[] = [], seen = new Set<string>(), hashes = new Map<string, number>();
  for (const value of v.assets) {
    const row = object(value, ["sourceKey", "reference", "original", "candidate"]);
    if (!key(row.sourceKey) || seen.has(row.sourceKey) || !["current", "historical", "unreviewed"].includes(String(row.reference))) fail();
    seen.add(row.sourceKey);
    const original = blob(row.original), candidate = blob(row.candidate);
    if (candidate.byteSize > original.byteSize) fail();
    // One digest cannot claim two sizes, including across original/candidate inventories.
    for (const b of [original, candidate]) {
      if (hashes.has(b.sha256) && hashes.get(b.sha256) !== b.byteSize) fail();
      hashes.set(b.sha256, b.byteSize);
    }
    assets.push({ sourceKey: row.sourceKey, reference: row.reference as MigrationAsset["reference"], original, candidate });
  }
  // Missing retirement entries can be legitimate; missing protected entries cannot be silently omitted.
  if ([...protectedKeys].some(k => !seen.has(k))) fail();
  const kept = assets.filter(a => !retired.has(a.sourceKey)).sort((a, b) => a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0);
  function variant(name: "original" | "candidate") {
    const objects = new Map<string, { objectKey: string; sha256: string; byteSize: number; sourceKeys: string[] }>();
    let referencedBytes = 0;
    for (const a of kept) {
      const b = a[name]; referencedBytes = add(referencedBytes, b.byteSize);
      const existing = objects.get(b.sha256);
      if (existing) existing.sourceKeys.push(a.sourceKey);
      else objects.set(b.sha256, { objectKey: `sha256/${b.sha256}`, ...b, sourceKeys: [a.sourceKey] });
    }
    const ordered = [...objects.values()].sort((a, b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
    const uniqueBytes = ordered.reduce((n, b) => add(n, b.byteSize), 0);
    const onePassUploadAndReadBytes = add(uniqueBytes, uniqueBytes);
    return { objects: ordered, summary: { uniqueObjects: ordered.length, referencedBytes, uniqueBytes,
      onePassUploadAndReadBytes, overRuntimeImageLimit: ordered.filter(b => b.byteSize > RUNTIME_IMAGE_LIMIT).length,
      fitsStorage: limits.storageAvailableBytes === null ? null : uniqueBytes <= (limits.storageAvailableBytes as number),
      fitsOnePassTransfer: limits.transferBudgetBytes === null ? null : onePassUploadAndReadBytes <= (limits.transferBudgetBytes as number) } };
  }
  return { format: "media-migration-plan-v1" as const, evidence: "metadata-only" as const,
    executionAuthorized: false as const, publicationScopeVerified: false as const,
    limits: { storageAvailableBytes: limits.storageAvailableBytes as number | null, transferBudgetBytes: limits.transferBudgetBytes as number | null },
    summary: { inventoryAssets: assets.length, retainedAssets: kept.length, excludedRetiredAssets: assets.length - kept.length,
      retiredKeysNotInInventory: [...retired].filter(k => !seen.has(k)).length, protectedAssets: protectedKeys.size,
      currentReferenceAssets: kept.filter(a => a.reference === "current").length,
      historicalReferenceAssets: kept.filter(a => a.reference === "historical").length,
      unreviewedAssets: kept.filter(a => a.reference === "unreviewed").length },
    retained: kept.map(a => ({ sourceKey: a.sourceKey, reference: a.reference, protected: protectedKeys.has(a.sourceKey),
      originalObjectKey: `sha256/${a.original.sha256}`, candidateObjectKey: `sha256/${a.candidate.sha256}` })),
    original: variant("original"), candidate: variant("candidate") };
}
