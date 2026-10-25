import type { SqlExecutor } from "../../src/server/database/sql.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { canonicalJson, configDigest, validateMedia } from "../../src/server/database/website-validation.ts";
import { INCREMENTAL_LOGIN_SQL } from "../../src/server/database/incremental-connection.ts";
import { readPublicationState } from "../../src/server/database/incremental-publication.ts";
import { createPublishedThumbnailReader, createPublishedThumbnailRegistrar, verifyPublishedThumbnails } from "../../src/server/database/published-thumbnails.ts";
import type { AcceptedFullBaseline } from "./full-baseline-artifact.ts";
import { planMediaAcceptance, type AcceptanceThumbnail } from "./media-acceptance.ts";
import { createDatabaseContentBaselineReader } from "./content-baseline.ts";
import { createMediaAcceptanceBudget } from "./media-acceptance-budget.ts";
import { parseThumbnailScope, type ThumbnailScope } from "./thumbnail-scope.ts";

export class ThumbnailRegistrationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ThumbnailRegistrationError"; this.code = code; }
}
export function registrationFail(code: string): never { throw new ThumbnailRegistrationError(code); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export interface VerifiedThumbnailCoverage {
  format: "published-thumbnail-verified-coverage-v1"; origin: string; prefix: string; receiptSha256: string;
  independentReaderVerified: true; objects: { sha256: string; byteSize: number; mime: "image/webp" }[];
}
interface Limits { durationMs: number; sqlRequestBytes: number; sqlResponseBytes: number; thumbnailScope?: ThumbnailScope }

/** Coverage is a reviewed operator attestation exported from earlier independent
 * object-read receipts. This SQL-only step cannot prove current object bytes. */
export function planThumbnailRegistration(config: WebsiteNotionConfig, artifact: AcceptedFullBaseline,
  candidates: readonly AcceptanceThumbnail[], coverage: VerifiedThumbnailCoverage, receiptSha256: string, limits: Limits) {
  try {
    const scope = limits.thumbnailScope === undefined ? undefined : parseThumbnailScope(limits.thumbnailScope);
    if (!coverage || Object.keys(coverage).length !== 6 || coverage.format !== "published-thumbnail-verified-coverage-v1" || coverage.independentReaderVerified !== true ||
      !hash(receiptSha256) || coverage.receiptSha256 !== receiptSha256 || !Array.isArray(coverage.objects) || coverage.objects.length > (scope?.maxObjects ?? 197) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,250}$/.test(coverage.prefix) || coverage.prefix.split("/").some(x => !x) ||
      !Number.isSafeInteger(limits.durationMs) || limits.durationMs < 10 || limits.durationMs > 480000 ||
      !Number.isSafeInteger(limits.sqlRequestBytes) || limits.sqlRequestBytes < 1 || limits.sqlRequestBytes > 2 * 1024 ** 2 ||
      !Number.isSafeInteger(limits.sqlResponseBytes) || limits.sqlResponseBytes < 1 || limits.sqlResponseBytes > 4 * 1024 ** 2 ||
      !Array.isArray(candidates) || candidates.length > (scope?.maxBindings ?? 197)) throw Error();
    const origin = new URL(coverage.origin);
    if (origin.protocol !== "https:" || origin.origin !== coverage.origin || !/^[a-z0-9][a-z0-9-]*-[0-9]{5,20}\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(origin.hostname)) throw Error();
    const verified = new Map<string, number>(); let coveredBytes = 0;
    for (const o of coverage.objects) {
      if (!o || Object.keys(o).length !== 3 || !hash(o.sha256) || o.mime !== "image/webp" || !Number.isSafeInteger(o.byteSize) || o.byteSize < 1 || verified.has(o.sha256)) throw Error();
      verified.set(o.sha256, o.byteSize); coveredBytes += o.byteSize;
    }
    if (coveredBytes > (scope?.maxBytes ?? 3886392)) throw Error();
    const originals = new Map(artifact?.media?.map(m => [m.assetId, m])); let changedParents = 0;
    const filtered = candidates.filter(c => {
      if (!c || Object.keys(c).length !== 4 || !/^a1\.[a-f0-9]{64}$/.test(c.parentAssetId) || !hash(c.parentSha256) || ![400, 800].includes(c.widthCap)) throw Error();
      validateMedia(c.thumbnail);
      const parent = originals.get(c?.parentAssetId);
      if (parent && hash(c.parentSha256) && parent.sha256 !== c.parentSha256) { changedParents++; return false; }
      return true;
    });
    const selected = planMediaAcceptance(config, artifact, filtered, { durationMs: limits.durationMs, sqlResponseBytes: limits.sqlResponseBytes, controlBytes: 0,
      ...(scope ? { thumbnailScope: scope } : {}) });
    const thumbnails = selected.thumbnails.filter(c => verified.get(c.thumbnail.sha256) === c.thumbnail.byteSize);
    const summary = { candidateBindings: candidates.length, selectedBindings: thumbnails.length, excludedHistoricalBindings: selected.summary.excludedHistoricalBindings,
      changedParents, unverifiedBindings: selected.thumbnails.length - thumbnails.length, verifiedObjectBytes: coveredBytes,
      sqlQueries: 18 + 3 * thumbnails.length, durationMs: limits.durationMs,
      sqlRequestBytes: limits.sqlRequestBytes, sqlResponseBytes: limits.sqlResponseBytes, httpRequests: 0 };
    const value = { format: "published-thumbnail-registration-plan-v1" as const, state: selected.state,
      pageIds: selected.pageIds, media: selected.media, thumbnails, coverageDigest: configDigest(coverage), receiptSha256,
      origin: coverage.origin, prefix: coverage.prefix, summary, ...(scope ? { thumbnailScope: scope } : {}) };
    return { ...structuredClone(value), digest: configDigest(value) };
  } catch { return registrationFail("THUMBNAIL_REGISTRATION_INPUT_INVALID"); }
}
export type ThumbnailRegistrationPlan = ReturnType<typeof planThumbnailRegistration>;

export function createThumbnailRegistrationBudget(plan: ThumbnailRegistrationPlan) {
  const budget = createMediaAcceptanceBudget({ ...plan.summary, mediaResponseBytes: 0 }); let sqlRequestBytes = 0;
  return { ...budget, sql(db: SqlExecutor): SqlExecutor {
    const bounded = budget.sql(db);
    return { query: <T>(text: string, values?: unknown[]) => {
      budget.guard(); const bytes = Buffer.byteLength(JSON.stringify({ text, values: values ?? [] }));
      if (sqlRequestBytes + bytes > plan.summary.sqlRequestBytes) { budget.cancel("THUMBNAIL_REGISTRATION_REQUEST_LIMIT"); return Promise.reject(new ThumbnailRegistrationError("THUMBNAIL_REGISTRATION_REQUEST_LIMIT")); }
      sqlRequestBytes += bytes; return bounded.query<T>(text, values);
    } };
  }, statistics: () => ({ ...budget.statistics(), sqlRequestBytes }) };
}
export type ThumbnailRegistrationBudget = ReturnType<typeof createThumbnailRegistrationBudget>;
export interface RegistrationProgress { phase: "preflight" | "writing" | "checking"; writeRequests: number; acknowledgedWrites: number; verifiedBindings: number;
  inFlight: { parentAssetId: string; widthCap: number } | null }

export async function runThumbnailRegistration(reviewedPlan: ThumbnailRegistrationPlan, input: { reader: SqlExecutor; writer: SqlExecutor;
  readerUrl: string; writerUrl: string; budget: ThumbnailRegistrationBudget; verifyOnly?: boolean;
  progress: (value: RegistrationProgress) => Promise<void> }) {
  const plan = structuredClone(reviewedPlan), { digest, ...body } = plan; if (configDigest(body) !== digest) registrationFail("THUMBNAIL_REGISTRATION_PLAN_CHANGED");
  const budget = input.budget, reader = budget.sql(input.reader), writer = budget.sql(input.writer);
  const progress: RegistrationProgress = { phase: "preflight", writeRequests: 0, acknowledgedWrites: 0, verifiedBindings: 0, inFlight: null };
  const save = async () => { await input.progress(structuredClone(progress)); budget.guard(); };
  const endpoint = (value: string) => { const u = new URL(value); return { key: JSON.stringify([u.hostname, u.port || "5432", u.pathname]), username: decodeURIComponent(u.username), database: decodeURIComponent(u.pathname.slice(1)) }; };
  const a = endpoint(input.readerUrl), b = endpoint(input.writerUrl);
  if (a.key !== b.key || a.username === b.username) registrationFail("THUMBNAIL_REGISTRATION_TARGET_INVALID");
  const readerFunctions = ["nb_publication_api.check_capability(text)", "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()", "nb_publication_api.read_snapshot(text[],boolean)",
    "nb_publication_api.check_thumbnail_capability(text)", "nb_publication_api.read_thumbnail(text,integer,text)"];
  const writerFunctions = ["nb_publication_api.check_capability(text)", "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()", "nb_publication_api.register_thumbnail(text,text,text,integer,jsonb,text)"];
  const profile = async (db: SqlExecutor, role: string, url: typeof a, functions: string[]) => {
    const rows = (await db.query<Record<string, unknown>>(INCREMENTAL_LOGIN_SQL, [role, functions])).rows, p = rows[0];
    if (rows.length !== 1 || !p || Object.keys(p).length !== 8 || ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"].some(k => p[k] !== true) ||
      typeof p.login !== "string" || p.database !== url.database || !url.username.startsWith(p.login) || !/^(?:\.[a-z0-9_-]{1,128})?$/.test(url.username.slice(p.login.length))) registrationFail("THUMBNAIL_REGISTRATION_ROLE_INVALID");
    return url.username.slice(p.login.length);
  };
  if (await profile(reader, "nb_delta_reader", a, readerFunctions) !== await profile(writer, "nb_writer", b, writerFunctions)) registrationFail("THUMBNAIL_REGISTRATION_TARGET_INVALID");
  const baseline = createDatabaseContentBaselineReader(reader), read = createPublishedThumbnailReader(reader), register = createPublishedThumbnailRegistrar(writer);
  const checkState = async () => {
    if (!same(await baseline.state(budget.signal), plan.state) || !same(await readPublicationState(writer), plan.state)) registrationFail("THUMBNAIL_REGISTRATION_PUBLICATION_CHANGED");
  };
  const checkMembers = async () => {
    const members = await baseline.inventory(plan.state.publicationRevision, budget.signal);
    if (!same([...members.pageIds].sort(), plan.pageIds) || !same([...members.mediaIds].sort(), plan.media.map(m => m.assetId).sort())) registrationFail("THUMBNAIL_REGISTRATION_MEMBERSHIP_CHANGED");
  };
  const originals = new Map(plan.media.map(m => [m.assetId, m])), missing: AcceptanceThumbnail[] = [];
  await save(); await verifyPublishedThumbnails(reader); await checkState(); await checkMembers();
  // Validate every selected parent and conflict before the first mutation.
  for (const t of plan.thumbnails) {
    const value = await read(t.parentAssetId, t.widthCap);
    if (!value || value.publicationRevision !== plan.state.publicationRevision || value.configDigest !== plan.state.configDigest || value.policyEpoch !== plan.state.policyEpoch ||
      !same(value.original, originals.get(t.parentAssetId))) registrationFail("THUMBNAIL_REGISTRATION_PARENT_CHANGED");
    if (value.thumbnail !== null && !same(value.thumbnail, t.thumbnail)) registrationFail("THUMBNAIL_REGISTRATION_CONFLICT");
    if (value.thumbnail === null) missing.push(t);
  }
  if (!input.verifyOnly) for (const t of missing) {
    progress.phase = "writing"; progress.inFlight = { parentAssetId: t.parentAssetId, widthCap: t.widthCap }; progress.writeRequests++; await save();
    await register.register({ expectedRevision: plan.state.publicationRevision, ...t }); progress.acknowledgedWrites++; progress.inFlight = null; await save();
  }
  progress.phase = "checking"; await save();
  for (const t of plan.thumbnails) {
    const value = await read(t.parentAssetId, t.widthCap);
    if (!value || value.publicationRevision !== plan.state.publicationRevision || value.configDigest !== plan.state.configDigest || value.policyEpoch !== plan.state.policyEpoch ||
      !same(value.original, originals.get(t.parentAssetId)) || !same(value.thumbnail, t.thumbnail)) registrationFail("THUMBNAIL_REGISTRATION_NOT_VERIFIED");
    progress.verifiedBindings++; await save();
  }
  await checkMembers(); await checkState(); budget.guard();
  return { outcome: input.verifyOnly ? "verified" : "registered-verified", ...progress, selectedBindings: plan.thumbnails.length };
}
