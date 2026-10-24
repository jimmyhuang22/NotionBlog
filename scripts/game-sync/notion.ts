import { Client, LogLevel, isNotionClientError } from "@notionhq/client";
import { setTimeout as pause } from "node:timers/promises";
import { GameSyncError, syncKey, observations } from "./model.ts";
import type { Observation } from "./model.ts";
import { digest, equalProperty, fingerprint, normalizedId, PLAN_VERSION, propertyValue, recordPage,
  requireSamePlan, writableProperties } from "./plan.ts";
import type { PropertyMap, RecordPage, SyncAction, SyncPlan, SyncProgress } from "./plan.ts";

const id = normalizedId;
const plain = (value: unknown) => {
  const prop = value as { type?: string; rich_text?: { plain_text?: string; text?: { content: string } }[] };
  if (prop?.type !== "rich_text" || !Array.isArray(prop.rich_text)) throw new GameSyncError("NOTION_SCHEMA_INVALID");
  return prop.rich_text.map(t => t.plain_text ?? t.text?.content ?? "").join("");
};
const text = (content: string) => ({ rich_text: [{ text: { content } }] });
export interface SyncConfig {
  recordsSourceId: string; gamesSourceId: string;
  bindings: Record<string, string>; excluded: string[];
}
export function properties(row: Observation, gameId?: string) {
  const p: Record<string, unknown> = {
    Provider: { select: { name: row.provider } }, Platform: text(row.platform),
    "Product ID": text(row.productId), Account: text(row.account), "Sync Key": text(syncKey(row)),
    "Sync Status": { select: { name: gameId ? "Current" : "Needs review" } },
    "Record Scope": { select: { name: row.scope } },
    "Total Playtime Minutes": { number: row.minutes }, "Playtime Precision": { select: { name: row.precision } },
    "First Played": { date: row.firstPlayed ? { start: row.firstPlayed } : null },
    "Last Played": { date: row.lastPlayed ? { start: row.lastPlayed } : null },
    "Source Updated At": { date: row.sourceUpdated ? { start: row.sourceUpdated } : null },
    "Synced At": { date: { start: row.syncedAt } },
    Ownership: row.ownership === null ? { rich_text: [] } : text(row.ownership),
  };
  if (gameId) p.Game = { relation: [{ id: gameId }] };
  for (const [field, value] of [["Trophy Progress", row.trophyProgress], ["Earned Trophies", row.earnedTrophies],
    ["Total Trophies", row.totalTrophies], ["Platinum Trophies", row.platinumTrophies]] as const) {
    // Missing trophy data leaves a verified prior value in place, rather than erasing it.
    if (value !== undefined) p[field] = { number: value };
  }
  if (row.trophySetId !== undefined) p["Trophy Set ID"] = text(row.trophySetId);
  if (row.recentMinutes !== undefined) p["Recent Playtime Minutes"] = { number: row.recentMinutes };
  if (row.productType !== undefined) p["Product Type"] = text(row.productType);
  if (row.productUrl !== undefined) p["Product URL"] = { url: row.productUrl };
  if (row.platformReleaseDate !== undefined) p["Platform Release Date"] = { date: row.platformReleaseDate ? { start: row.platformReleaseDate } : null };
  return p;
}

export interface SyncOptions {
  expectedPlan?: unknown;
  onPlan?: (plan: SyncPlan) => Promise<void>;
  onProgress?: (progress: SyncProgress) => Promise<void>;
}

function correctHours(value: unknown, expected: number | null): boolean {
  const f = (value as { formula?: { type?: string; number?: number | null; string?: string | null } })?.formula;
  return expected === null ? f?.type === "string" && f.string === "" || f?.type === "number" && f.number === null :
    f?.type === "number" && typeof f.number === "number" && Math.abs(f.number - expected) <= 1e-8;
}

/** Only mutates account records. Plans and journals contain private data and must stay in the private directory. */
export async function syncNotion(token: string, config: SyncConfig, rows: Observation[], apply: boolean, port?: Client, options: SyncOptions = {}) {
  observations(rows);
  const client = port ?? new Client({ auth: token, notionVersion: "2026-03-11", timeoutMs: 20000, retry: false,
    logLevel: LogLevel.ERROR, logger: () => {} });
  // Pace real SDK requests. A possibly committed mutation is never retried automatically.
  let lastRequest = 0;
  async function request<T>(call: () => Promise<T>): Promise<T> {
    if (!port) await pause(Math.max(0, 650 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    try { return await call(); }
    catch (e) {
      if (isNotionClientError(e)) throw new GameSyncError(e.code === "rate_limited" ? "NOTION_RATE_LIMITED" :
        e.code === "unauthorized" ? "NOTION_AUTH_REQUIRED" : "NOTION_REQUEST_FAILED");
      throw e;
    }
  }
  async function pages(sourceId: string): Promise<RecordPage[]> {
    const all: RecordPage[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await request(() => client.dataSources.query({ data_source_id: sourceId, page_size: 100, start_cursor: cursor }));
      all.push(...result.results.map(p => recordPage(p, sourceId)));
      if (all.length > 10000) throw new GameSyncError("LIMIT_EXCEEDED");
      if (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor))) throw new GameSyncError("NOTION_SCOPE_INCOMPLETE");
      cursor = result.has_more ? result.next_cursor! : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return all;
  }
  const source = await request(() => client.dataSources.retrieve({ data_source_id: config.recordsSourceId }));
  const schema = source.properties;
  for (const [name, type] of Object.entries({ Name: "title", Game: "relation", Provider: "select", Platform: "rich_text",
    "Product ID": "rich_text", Account: "rich_text", "Sync Key": "rich_text", "Sync Status": "select",
    "Record Scope": "select", "Total Playtime Minutes": "number", "Playtime Precision": "select",
    "First Played": "date", "Last Played": "date", "Source Updated At": "date", "Synced At": "date",
    Ownership: "rich_text", "Trophy Set ID": "rich_text", "Trophy Progress": "number", "Earned Trophies": "number",
    "Total Trophies": "number", "Platinum Trophies": "number" })) {
    if (schema[name]?.type !== type) throw new GameSyncError("NOTION_SCHEMA_INVALID");
  }
  if (schema.Game.type !== "relation" || id(schema.Game.relation.data_source_id ?? "") !== id(config.gamesSourceId) ||
      id(config.recordsSourceId) === id(config.gamesSourceId)) throw new GameSyncError("NOTION_SCOPE_INVALID");
  for (const [name, type] of Object.entries({ "Recent Playtime Minutes": "number", "Product Type": "rich_text", "Product URL": "url", "Platform Release Date": "date" })) {
    if (rows.some(r => r.provider === "Steam") && schema[name]?.type !== type) throw new GameSyncError("NOTION_SCHEMA_INVALID");
  }
  function index(records: RecordPage[]) {
    const existing = new Map<string, { page: RecordPage; gameId?: string }>();
    for (const page of records) {
      const key = plain(page.properties["Sync Key"]);
      if (!key) continue;
      const provider = page.properties.Provider as { type?: string; select?: { name: string } | null };
      if (provider?.type !== "select" || !provider.select ||
          !["Steam", "PSN", "Nintendo"].includes(provider.select.name) || key !== syncKey({ provider: provider.select.name as Observation["provider"],
          platform: plain(page.properties.Platform), productId: plain(page.properties["Product ID"]), account: plain(page.properties.Account) }) ||
          existing.has(key)) throw new GameSyncError("DUPLICATE_OR_INVALID_BINDING");
      const game = page.properties.Game as { type?: string; has_more?: boolean; relation?: { id: string }[] };
      if (game?.type !== "relation" || game.has_more || !Array.isArray(game.relation) || game.relation.length > 1) {
        throw new GameSyncError("DUPLICATE_OR_INVALID_BINDING");
      }
      existing.set(key, { page, gameId: game.relation[0]?.id });
    }
    return existing;
  }
  const beforeRecords = await pages(config.recordsSourceId), existing = index(beforeRecords);
  const denied = new Set(config.excluded), actions: SyncAction[] = [];
  const counts = { create: 0, update: 0, archive: 0, unchanged: 0, unmatched: 0, skipped: 0 };
  const gameIds = new Set<string>();
  for (const row of rows) {
    const key = syncKey(row), previous = existing.get(key), lookup = `${row.provider}:${row.platform}:${row.productId}`;
    const exclude = row.visibility === "excluded" || denied.has(lookup);
    if (row.visibility === "unknown" || previous?.page.archived || previous?.page.in_trash || (exclude && !previous)) { counts.skipped++; continue; }
    const mapped = config.bindings[lookup];
    if (mapped && previous?.gameId && id(mapped) !== id(previous.gameId)) throw new GameSyncError("BINDING_CONFLICT");
    const gameId = mapped ?? previous?.gameId;
    if (gameId) gameIds.add(id(gameId));
    if (!exclude && !gameId) counts.unmatched++;
    if (exclude) {
      actions.push({ key, kind: "archive", pageId: previous!.page.id, before: fingerprint(previous!.page), gameId,
        properties: { Game: { relation: [] }, "Sync Status": { select: { name: "Excluded" } } } }); counts.archive++;
    } else if (!previous) {
      actions.push({ key, kind: "create", gameId, properties: { ...properties(row, gameId), Name: { title: [{ text: { content: row.name } }] } } }); counts.create++;
    } else {
      const desired = properties(row, gameId), patch: PropertyMap = {};
      for (const [name, prop] of Object.entries(desired)) {
        if (name !== "Synced At" && name !== "Source Updated At" && !equalProperty(previous.page.properties[name], prop)) patch[name] = prop;
      }
      if (!Object.keys(patch).length) { counts.unchanged++; continue; }
      patch["Synced At"] = desired["Synced At"];
      if (!equalProperty(previous.page.properties["Source Updated At"], desired["Source Updated At"])) patch["Source Updated At"] = desired["Source Updated At"];
      actions.push({ key, kind: "update", pageId: previous.page.id, before: fingerprint(previous.page), gameId, properties: patch }); counts.update++;
    }
  }
  // Query the full Game source once, rather than retrieving every bound work on every run.
  const games = gameIds.size ? (await pages(config.gamesSourceId)).filter(p => gameIds.has(id(p.id))) : [];
  if (games.length !== gameIds.size || games.some(p => p.archived || p.in_trash)) throw new GameSyncError("NOTION_SCOPE_INVALID");
  const gameBefore = new Map(games.map(p => [id(p.id), p]));
  const plan: SyncPlan = { version: PLAN_VERSION, inputDigest: digest([config, rows]),
    stateDigest: digest({ schema, records: beforeRecords.map(p => [id(p.id), fingerprint(p)]).sort(),
      games: games.map(p => [id(p.id), fingerprint(p, true)]).sort() }), actions, counts };
  if (apply && options.expectedPlan !== undefined) requireSamePlan(options.expectedPlan, plan);
  await options.onPlan?.(structuredClone(plan));
  const progress: SyncProgress = { completed: [], pending: null, verified: false };
  const report = { ...counts, applied: apply, verified: 0 };
  if (!apply) return report;
  await options.onProgress?.(structuredClone(progress));

  async function verifyRead<T>(check: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await check(); }
      catch (e) {
        if (!(e instanceof GameSyncError) || e.code !== "READBACK_FAILED" || attempt === 2) throw e;
        if (!port) await pause((attempt + 1) * 1000);
      }
    }
  }
  const afterWritten = new Map<string, RecordPage>();
  for (const action of actions) {
    const previous = existing.get(action.key)?.page;
    if (previous) {
      const current = recordPage(await request(() => client.pages.retrieve({ page_id: previous.id })), config.recordsSourceId);
      if (fingerprint(current) !== action.before) throw new GameSyncError("PLAN_CHANGED");
    }
    progress.pending = { key: action.key, kind: action.kind, pageId: action.pageId, stage: "requesting" };
    // Persist intent before a request: if transport fails after a commit, re-plan by stable key, never retry blindly.
    await options.onProgress?.(structuredClone(progress));
    const result = action.kind === "create"
      ? await request(() => client.pages.create({ parent: { type: "data_source_id", data_source_id: config.recordsSourceId },
          properties: action.properties as Parameters<typeof client.pages.create>[0]["properties"] }))
      : await request(() => client.pages.update({ page_id: action.pageId!, ...(action.kind === "archive" ? { archived: true } : {}),
          properties: action.properties as Parameters<typeof client.pages.update>[0]["properties"] }));
    if (!result || typeof result.id !== "string") throw new GameSyncError("READBACK_FAILED");
    const pageId = result.id;
    if (action.pageId && id(pageId) !== id(action.pageId)) throw new GameSyncError("READBACK_FAILED");
    progress.pending = { key: action.key, kind: action.kind, pageId, stage: "written" };
    await options.onProgress?.(structuredClone(progress));
    const readback = await verifyRead(async () => {
      const page = recordPage(await request(() => client.pages.retrieve({ page_id: pageId })), config.recordsSourceId);
      if ((page.archived || page.in_trash) !== (action.kind === "archive") ||
          Object.entries(action.properties).some(([name, prop]) => !equalProperty(page.properties[name], prop))) throw new GameSyncError("READBACK_FAILED");
      if (previous && (digest(page.cover ?? null) !== digest(previous.cover ?? null) || digest(page.icon ?? null) !== digest(previous.icon ?? null) ||
          Object.entries(writableProperties(previous)).some(([name, prop]) => !Object.hasOwn(action.properties, name) && digest(page.properties[name]) !== digest(prop)))) {
        throw new GameSyncError("READBACK_FAILED");
      }
      const minutes = propertyValue(page.properties["Total Playtime Minutes"]), hours = page.properties["Playtime Hours"];
      if (hours && !correctHours(hours, typeof minutes === "number" ? minutes / 60 : null)) throw new GameSyncError("READBACK_FAILED");
      return page;
    });
    afterWritten.set(action.key, readback);
    progress.completed.push({ key: action.key, kind: action.kind, pageId }); progress.pending = null;
    await options.onProgress?.(structuredClone(progress)); report.verified++;
  }
  // Verify the final collection too: detect duplicates, unrelated edits and a late change to a previously verified row.
  if (actions.length) {
    const afterRecords = await pages(config.recordsSourceId), after = index(afterRecords);
    const afterById = new Map(afterRecords.map(p => [id(p.id), p]));
    for (const previous of beforeRecords) {
      const key = plain(previous.properties["Sync Key"]), written = afterWritten.get(key);
      if (written?.archived || written?.in_trash) {
        const archived = recordPage(await request(() => client.pages.retrieve({ page_id: written.id })), config.recordsSourceId);
        if (fingerprint(archived) !== fingerprint(written)) throw new GameSyncError("READBACK_FAILED");
        continue;
      }
      const current = afterById.get(id(previous.id));
      if (!current || fingerprint(current) !== fingerprint(written ?? previous)) throw new GameSyncError("READBACK_FAILED");
    }
    for (const action of actions.filter(a => a.kind === "create")) {
      if (!after.has(action.key) || fingerprint(after.get(action.key)!.page) !== fingerprint(afterWritten.get(action.key)!)) throw new GameSyncError("READBACK_FAILED");
    }
    for (const gameId of new Set(actions.map(a => a.gameId).filter((v): v is string => Boolean(v)))) {
      const before = gameBefore.get(id(gameId))!;
      await verifyRead(async () => {
        const page = recordPage(await request(() => client.pages.retrieve({ page_id: gameId })), config.gamesSourceId);
        if (fingerprint(page, true) !== fingerprint(before, true)) throw new GameSyncError("READBACK_FAILED");
        // If the configured Game exposes the standard rollups, verify their expected delta and effective hours.
        const rollup = (p: RecordPage, name: string) => (p.properties[name] as { rollup?: { type?: string; number?: number } })?.rollup;
        const count = rollup(before, "Platform Time Count"), minutes = rollup(before, "Platform Playtime Minutes");
        if (count?.type === "number" && minutes?.type === "number" && typeof count.number === "number" && typeof minutes.number === "number") {
          let expectedCount = count.number, expectedMinutes = minutes.number;
          for (const action of actions.filter(a => a.gameId && id(a.gameId) === id(gameId))) {
            const prior = existing.get(action.key), old = prior?.gameId ? propertyValue(prior.page.properties["Total Playtime Minutes"]) : null;
            const next = action.kind === "archive" ? null : propertyValue(afterWritten.get(action.key)!.properties["Total Playtime Minutes"]);
            expectedCount += Number(typeof next === "number") - Number(typeof old === "number");
            expectedMinutes += (typeof next === "number" ? next : 0) - (typeof old === "number" ? old : 0);
          }
          const actualCount = rollup(page, "Platform Time Count"), actualMinutes = rollup(page, "Platform Playtime Minutes");
          const hours = page.properties["Playtime Hours"];
          const fallback = propertyValue(before.properties["Played Time"]);
          const expectedHours = expectedCount > 0 ? expectedMinutes / 60 : typeof fallback === "number" ? fallback : null;
          if (actualCount?.number !== expectedCount || typeof actualMinutes?.number !== "number" || Math.abs(actualMinutes.number - expectedMinutes) > 1e-8 ||
              (hours && !correctHours(hours, expectedHours))) throw new GameSyncError("READBACK_FAILED");
        }
      });
    }
  }
  progress.verified = true; await options.onProgress?.(structuredClone(progress));
  return report;
}
