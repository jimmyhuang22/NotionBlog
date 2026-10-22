import type { StoredMedia } from "../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { INCREMENTAL_LOGIN_SQL } from "../../src/server/database/incremental-connection.ts";
import { canonicalJson, configDigest, mediaIdentity, validateMedia } from "../../src/server/database/website-validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { createPublishedThumbnailReader, verifyPublishedThumbnails } from "../../src/server/database/published-thumbnails.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { assertFullBaselineConfig, type AcceptedFullBaseline } from "./full-baseline-artifact.ts";
import { validateStudyBaselineCollection } from "./study-baseline.ts";
import { createDatabaseContentBaselineReader } from "./content-baseline.ts";
import { acceptanceFail as fail, type MediaAcceptanceBudget } from "./media-acceptance-budget.ts";
import { parseThumbnailScope, type ThumbnailScope } from "./thumbnail-scope.ts";

export interface AcceptanceThumbnail { parentAssetId: string; parentSha256: string; widthCap: 400 | 800; thumbnail: StoredMedia }
export interface MediaAcceptanceLimits { durationMs: number; sqlResponseBytes: number; controlBytes: number; thumbnailScope?: ThumbnailScope }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requiredFunctions = ["nb_publication_api.check_capability(text)", "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()",
  "nb_publication_api.read_snapshot(text[],boolean)", "nb_publication_api.check_thumbnail_capability(text)", "nb_publication_api.read_thumbnail(text,integer,text)"];

/** Offline selection from the SAME accepted collection. Historical candidates
 * whose parent is not in that collection are excluded, never published here. */
export function planMediaAcceptance(config: WebsiteNotionConfig, artifact: AcceptedFullBaseline, candidates: readonly AcceptanceThumbnail[], limits: MediaAcceptanceLimits) {
  try {
    const scope = limits.thumbnailScope === undefined ? undefined : parseThumbnailScope(limits.thumbnailScope);
    assertFullBaselineConfig(config);
    if (!artifact || Object.keys(artifact).length !== 7 || artifact.format !== "incremental-baseline-v1" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(artifact.fullRunId) ||
      !artifact.state || Object.keys(artifact.state).length !== 4 || !artifact.state.publicationRevision.startsWith(`${artifact.fullRunId}:`) ||
      !/^[0-9]{1,20}$/.test(artifact.state.publicationRevision.slice(artifact.fullRunId.length + 1)) ||
      artifact.state.schemaDigest !== WEBSITE_SCHEMA_DIGEST || artifact.state.configDigest !== configDigest(config) ||
      !/^[0-9]{1,20}$/.test(artifact.state.policyEpoch) || !Array.isArray(artifact.deniedPageIds) ||
      !same(artifact.deniedPageIds, [...new Set(artifact.deniedPageIds.map(normalizeId))].sort()) ||
      !Array.isArray(artifact.media) || artifact.media.length > 20000 || !Array.isArray(candidates) || candidates.length > 40000 ||
      !Number.isSafeInteger(limits.controlBytes) || limits.controlBytes < 0 || limits.controlBytes > 1024 ** 2 ||
      !Number.isSafeInteger(limits.durationMs) || limits.durationMs < 10 || limits.durationMs > 2700000 ||
      !Number.isSafeInteger(limits.sqlResponseBytes) || limits.sqlResponseBytes < 1 || limits.sqlResponseBytes > 64 * 1024 ** 2) throw Error();
    if (scope && candidates.length > scope.maxBindings) fail("MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT");
    validateStudyBaselineCollection(artifact.collection, config, new Set(artifact.deniedPageIds));
    if (artifact.directory.configDigest !== artifact.state.configDigest || artifact.directory.recordsDigest !==
      configDigest([...artifact.collection.records].sort((a, b) => a.detail.item.id.localeCompare(b.detail.item.id)))) throw Error();
    const pages = new Set(artifact.collection.records.map(r => r.detail.item.id)), assets = new Map<string, StoredMedia>();
    const objects = new Map<string, StoredMedia>();
    function add(media: StoredMedia) {
      validateMedia(media); const previous = objects.get(media.objectKey);
      if (previous && !same([previous.sha256, previous.byteSize, previous.mime, previous.width, previous.height],
        [media.sha256, media.byteSize, media.mime, media.width, media.height])) throw Error();
      objects.set(media.objectKey, media);
    }
    for (const media of artifact.media) {
      validateMedia(media); if (!pages.has(media.ownerPageId) || assets.has(media.assetId)) throw Error();
      assets.set(media.assetId, media); add(media);
    }
    const originalObjects = objects.size, originalBytes = [...objects.values()].reduce((n, m) => n + m.byteSize, 0);
    if (originalBytes > 2 * 1024 ** 3) fail("MEDIA_ACCEPTANCE_ORIGINAL_LIMIT");
    const selected: AcceptanceThumbnail[] = [], seen = new Set<string>(), thumbnailObjects = new Set<string>(); let excluded = 0;
    for (const entry of candidates) {
      if (!entry || Object.keys(entry).length !== 4 || !/^a1\.[a-f0-9]{64}$/.test(entry.parentAssetId) ||
        !/^[a-f0-9]{64}$/.test(entry.parentSha256) || ![400, 800].includes(entry.widthCap)) throw Error();
      validateMedia(entry.thumbnail);
      const key = `${entry.parentAssetId}:${entry.widthCap}`; if (seen.has(key)) throw Error(); seen.add(key);
      const original = assets.get(entry.parentAssetId); if (!original) { excluded++; continue; }
      const m = entry.thumbnail;
      if (entry.parentSha256 !== original.sha256 || m.ownerPageId !== original.ownerPageId || m.mime !== "image/webp" ||
        m.assetId !== mediaIdentity(m.ownerPageId, `thumbnail:${entry.widthCap}:${original.assetId}`, m.sha256) ||
        m.byteSize >= original.byteSize || !Number.isInteger(m.width) || m.width! < 1 || m.width! > entry.widthCap ||
        !Number.isInteger(m.height) || m.height! < 1 || m.height! > 16383 ||
        original.width !== null && m.width! > original.width || original.height !== null && m.height! > original.height) throw Error();
      selected.push(structuredClone(entry)); add(m); thumbnailObjects.add(m.objectKey);
    }
    const objectBytes = [...objects.values()].reduce((n, m) => n + m.byteSize, 0), thumbnailBytes = objectBytes - originalBytes;
    if (thumbnailBytes > (scope?.maxBytes ?? 15 * 1024 ** 2) || scope && thumbnailObjects.size > scope.maxObjects) fail("MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT");
    const summary = { originalAssets: assets.size, originalObjects, originalBytes, thumbnailBindings: selected.length,
      excludedHistoricalBindings: excluded, additionalThumbnailBytes: thumbnailBytes, uniqueObjects: objects.size,
      httpRequests: objects.size, sqlQueries: 11 + 4 * assets.size, sqlResponseBytes: limits.sqlResponseBytes,
      mediaResponseBytes: objectBytes + limits.controlBytes, durationMs: limits.durationMs };
    const input = { state: artifact.state, fullRunId: artifact.fullRunId, pageIds: [...pages].sort(),
      media: [...assets.values()].sort((a, b) => a.assetId.localeCompare(b.assetId)),
      thumbnails: selected.sort((a, b) => `${a.parentAssetId}:${a.widthCap}`.localeCompare(`${b.parentAssetId}:${b.widthCap}`)),
      objects: [...objects.values()], summary, ...(scope ? { thumbnailScope: scope } : {}) };
    return { ...structuredClone(input), digest: configDigest(input) };
  } catch (e) { if (e instanceof Error && e.name === "MediaAcceptanceError") throw e; return fail("MEDIA_ACCEPTANCE_INPUT_INVALID"); }
}
export type MediaAcceptancePlan = ReturnType<typeof planMediaAcceptance>;

/** No writer or source port, and no public output. Native CLI must verify TLS
 * and supply a dedicated read-only connection / independent COS credential. */
export async function verifyMediaAcceptance(plan: MediaAcceptancePlan, input: { reader: SqlExecutor; readerUrl: string;
  storage: Pick<ObjectStorage, "read">; budget: MediaAcceptanceBudget }) {
  const { digest, ...bound } = plan;
  if (configDigest(bound) !== digest) fail("MEDIA_ACCEPTANCE_PLAN_CHANGED");
  const { budget } = input, db = budget.sql(input.reader); budget.guard();
  const endpoint = new URL(input.readerUrl);
  const profile = (await db.query<Record<string, unknown>>(INCREMENTAL_LOGIN_SQL, ["nb_reader", requiredFunctions])).rows;
  const keys = ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"];
  const p = profile[0], username = decodeURIComponent(endpoint.username);
  if (profile.length !== 1 || !p || Object.keys(p).length !== 8 || keys.some(k => p[k] !== true) ||
    typeof p.login !== "string" || p.database !== decodeURIComponent(endpoint.pathname.slice(1)) ||
    !username.startsWith(p.login) || !/^(?:\.[a-z0-9_-]{1,128})?$/.test(username.slice(p.login.length))) fail("MEDIA_ACCEPTANCE_READER_ROLE_INVALID");
  const reader = createDatabaseContentBaselineReader(db), thumbnailReader = createPublishedThumbnailReader(db);
  const checkState = async () => { if (!same(await reader.state(budget.signal), plan.state)) fail("MEDIA_ACCEPTANCE_PUBLICATION_CHANGED"); };
  const checkMembers = async () => {
    const inventory = await reader.inventory(plan.state.publicationRevision, budget.signal);
    if (!same([...inventory.pageIds].sort(), plan.pageIds) || !same([...inventory.mediaIds].sort(), plan.media.map(m => m.assetId).sort())) fail("MEDIA_ACCEPTANCE_MEMBERSHIP_CHANGED");
  };
  const expected = new Map(plan.thumbnails.map(t => [`${t.parentAssetId}:${t.widthCap}`, t.thumbnail]));
  const checkDescriptors = async () => {
    for (const media of plan.media) for (const width of [400, 800] as const) {
      budget.guard(); const value = await thumbnailReader(media.assetId, width); budget.guard();
      if (!value || value.publicationRevision !== plan.state.publicationRevision || value.configDigest !== plan.state.configDigest ||
        value.policyEpoch !== plan.state.policyEpoch || !same(value.original, media) ||
        !same(value.thumbnail, expected.get(`${media.assetId}:${width}`) ?? null)) fail("MEDIA_ACCEPTANCE_DESCRIPTOR_CHANGED");
    }
  };
  await checkState(); await verifyPublishedThumbnails(db); await checkMembers(); await checkDescriptors();
  let objectsRead = 0;
  for (const media of plan.objects) {
    const bytes = await budget.wait(() => input.storage.read(media)); budget.guard(); verifyMediaBytes(media, bytes); objectsRead++;
  }
  // Withdrawal/ancestor and variant checks still run for every asset, even if
  // multiple qualified owners share one deduplicated object.
  await checkDescriptors(); await checkMembers(); await checkState(); budget.guard();
  return { outcome: "verified" as const, readerRoleVerified: true, objectsRead, ...plan.summary };
}
