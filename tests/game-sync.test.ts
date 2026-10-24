import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@notionhq/client";
import { date, durationMinutes, nintendoRows, observations, psnRows, syncKey } from "../scripts/game-sync/model.ts";
import type { Observation } from "../scripts/game-sync/model.ts";
import { callbackCode, CLIENT_ID, loginRequest } from "../scripts/game-sync/nintendo.ts";
import { properties, syncNotion } from "../scripts/game-sync/notion.ts";
import { steamPolicy, steamRows } from "../scripts/game-sync/steam.ts";
import { digest } from "../scripts/game-sync/plan.ts";
import type { SyncPlan, SyncProgress } from "../scripts/game-sync/plan.ts";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", gameId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  gamesSourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row: Observation = { provider: "PSN", account: "test-account", platform: "PS5", productId: "PPSA00001_00",
  name: "Example game", minutes: 0, precision: "Second", firstPlayed: null, lastPlayed: null, sourceUpdated: null,
  syncedAt: "2026-01-01T00:00:00.000Z", visibility: "allowed", scope: "Played", ownership: null };
const config = { recordsSourceId: sourceId, gamesSourceId, bindings: {}, excluded: [] as string[] };
const recordId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function apiProperties(values: Record<string, any>) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const type = Object.keys(value).find(k => k !== "id")!;
    const p = { ...structuredClone(value), type };
    if (type === "title" || type === "rich_text") p[type] = p[type].map((t: any) => ({ ...t, plain_text: t.plain_text ?? t.text?.content ?? "" }));
    return [name, p];
  }));
}
function existing(r = row, relation: string[] = []) {
  return { object: "page", id: recordId, parent: { type: "data_source_id", data_source_id: sourceId }, archived: false, in_trash: false,
    properties: apiProperties({ ...properties(r, relation[0]), Game: { relation: relation.map(id => ({ id })) },
      Name: { title: [{ text: { content: "User title" } }] }, "Review Notes": { rich_text: [{ text: { content: "User notes" }, annotations: { bold: true } }] } }) };
}
function fake(initial: unknown[] = [], wrongSource = false) {
  const records = structuredClone(initial) as any[];
  const writes: { action: string; data: any }[] = [];
  const hooks: { afterWrite?: (data: any) => void; retrieve?: (page: any) => any; query?: () => void } = {};
  const game: any = { object: "page", id: gameId, parent: { type: "data_source_id", data_source_id: wrongSource ? gameId : gamesSourceId },
    archived: false, in_trash: false, properties: apiProperties({ Name: { title: [{ text: { content: "User work" } }] },
      Rating: { number: 5 }, "Played Time": { number: 7 } }) };
  function derive() {
    for (const p of records) {
      const minutes = p.properties["Total Playtime Minutes"].number;
      p.properties["Playtime Hours"] = { type: "formula", formula: typeof minutes === "number" ? { type: "number", number: minutes / 60 } : { type: "string", string: "" } };
    }
    const related = records.filter(p => !p.archived && !p.in_trash && p.properties.Game.relation.some((r: any) => r.id === gameId));
    const timed = related.filter(p => typeof p.properties["Total Playtime Minutes"].number === "number");
    const minutes = timed.reduce((a, p) => a + p.properties["Total Playtime Minutes"].number, 0);
    game.properties["Platform Records"] = { type: "relation", relation: related.map(p => ({ id: p.id })) };
    game.properties["Platform Playtime Minutes"] = { type: "rollup", rollup: { type: "number", number: minutes } };
    game.properties["Platform Time Count"] = { type: "rollup", rollup: { type: "number", number: timed.length } };
    game.properties["Playtime Hours"] = { type: "formula", formula: { type: "number", number: timed.length ? minutes / 60 : game.properties["Played Time"].number } };
  }
  const schema = Object.fromEntries(Object.entries({ Name: "title", Game: "relation", Provider: "select", Platform: "rich_text",
    "Product ID": "rich_text", Account: "rich_text", "Sync Key": "rich_text", "Sync Status": "select", "Record Scope": "select",
    "Total Playtime Minutes": "number", "Playtime Precision": "select", "First Played": "date", "Last Played": "date",
    "Source Updated At": "date", "Synced At": "date", Ownership: "rich_text", "Trophy Set ID": "rich_text",
    "Trophy Progress": "number", "Earned Trophies": "number", "Total Trophies": "number", "Platinum Trophies": "number",
    "Recent Playtime Minutes": "number", "Product Type": "rich_text", "Product URL": "url", "Platform Release Date": "date" })
    .map(([key, type]) => [key, { type, ...(key === "Game" ? { relation: { data_source_id: gamesSourceId } } : {}) }]));
  const client = { dataSources: { retrieve: async () => ({ properties: schema }),
    query: async (data: any) => { hooks.query?.(); derive(); return { results: structuredClone(data.data_source_id === sourceId ? records.filter(p => !p.archived && !p.in_trash) : [game]), has_more: false }; } }, pages: {
    retrieve: async (data: any) => { derive(); const page = structuredClone(data.page_id === gameId ? game : records.find(p => p.id === data.page_id)); return hooks.retrieve ? hooks.retrieve(page) : page; },
    create: async (data: any) => {
      writes.push({ action: "create", data: structuredClone(data) });
      const p = { object: "page", id: `eeeeeeee-eeee-4eee-8eee-${String(records.length).padStart(12, "0")}`, parent: data.parent,
        archived: false, in_trash: false, properties: apiProperties({ Game: { relation: [] }, ...data.properties }) };
      records.push(p); derive(); hooks.afterWrite?.(data); return structuredClone(p);
    },
    update: async (data: any) => {
      writes.push({ action: "update", data: structuredClone(data) });
      const p = records.find(p => p.id === data.page_id);
      Object.assign(p.properties, apiProperties(data.properties)); if (data.archived) p.archived = true;
      derive(); hooks.afterWrite?.(data); return structuredClone(p);
    }
  } } as unknown as Client;
  return { client, writes, records, game, hooks };
}

test("PSN duration keeps seconds and a real zero, missing stays unknown", () => {
  assert.equal(durationMinutes("PT1H1M30S"), 61.5);
  assert.equal(durationMinutes("P1DT1H"), 1500);
  assert.equal(durationMinutes("PT0S"), 0);
  assert.equal(durationMinutes(null), null);
  for (const value of ["P1M", "P", "PT", "-PT1H", 5]) assert.throws(() => durationMinutes(value));
});
test("stable keys separate accounts, providers, platforms and editions", () => {
  const keys = [row, { ...row, account: "other" }, { ...row, platform: "PS4" }, { ...row, productId: "PPSA00002_00" },
    { ...row, provider: "Nintendo" as const }].map(syncKey);
  assert.equal(new Set(keys).size, 5);
});
test("Nintendo hidden titles are excluded before any writer, zero is preserved", () => {
  const base = { titleId: "0100000000000001", titleName: "Example", deviceType: "BEE", totalPlayedMinutes: 0 };
  const rows = nintendoRows({ playHistories: [base], hiddenTitleList: [base.titleId] }, "main", row.syncedAt);
  assert.equal(rows[0].visibility, "excluded"); assert.equal(rows[0].minutes, 0); assert.equal(rows[0].firstPlayed, null);
  assert.throws(() => nintendoRows({ playHistories: [base] }, "main", row.syncedAt));
  assert.throws(() => nintendoRows({ playHistories: [base], hiddenTitleList: [{}] }, "main", row.syncedAt));
});
test("Nintendo duplicates and partial pagination cannot become an apparently complete import", () => {
  const base = { titleId: "01", titleName: "Example", deviceType: "BEE" };
  assert.throws(() => nintendoRows({ playHistories: [base, base], hiddenTitleList: [] }, "main", row.syncedAt));
  assert.throws(() => nintendoRows({ playHistories: [base], hiddenTitleList: [], nextCursor: "next" }, "main", row.syncedAt));
});
test("Nintendo Store v2 platform field is supported and unknown platforms are withheld", () => {
  const base = { titleId: "01", titleName: "Example", platform: "BEE", totalPlayedMinutes: 0 };
  assert.equal(nintendoRows({ playHistories: [base], hiddenTitleList: [] }, "main", row.syncedAt)[0].platform, "Nintendo Switch 2");
  assert.equal(nintendoRows({ playHistories: [{ ...base, platform: "NEW" }], hiddenTitleList: [] }, "main", row.syncedAt)[0].visibility, "unknown");
});
test("PSN missing privacy is unknown and hidden trophies exclude a game", () => {
  const input = [{ titleId: row.productId, name: row.name, category: "ps5_native_game", playDuration: "PT0S" }];
  assert.equal(psnRows(input, "main", row.syncedAt, new Map())[0].visibility, "unknown");
  const sets = new Map([[row.productId, [{ hiddenFlag: true }]]]);
  assert.equal(psnRows(input, "main", row.syncedAt, sets)[0].visibility, "excluded");
});
test("PSN trophy progress remains distinct from personal play status", () => {
  const input = [{ titleId: row.productId, name: row.name, category: "ps5_native_game", playDuration: "PT30S" }];
  const sets = new Map([[row.productId, [{ hiddenFlag: false, npCommunicationId: "NPWR00001_00", progress: 100,
    earnedTrophies: { bronze: 2, silver: 1, gold: 1, platinum: 1 }, definedTrophies: { bronze: 2, silver: 1, gold: 1, platinum: 1 } }]]]);
  const r = psnRows(input, "main", row.syncedAt, sets)[0];
  assert.equal(r.minutes, .5); assert.equal(r.earnedTrophies, 5); assert.equal(r.trophyProgress, 100);
  assert.equal(properties(r).Status, undefined);
});
test("Nintendo OAuth verifies state and callback origin, uses fresh PKCE", () => {
  const a = loginRequest(), b = loginRequest(); assert.notEqual(a.verifier, b.verifier);
  const callback = `npf${CLIENT_ID}://auth#state=${a.state}&session_token_code=example`;
  assert.equal(callbackCode(callback, a.state), "example");
  assert.throws(() => callbackCode(callback, b.state));
  assert.throws(() => callbackCode(callback.replace(`npf${CLIENT_ID}`, "https"), a.state));
});
test("writer keeps unknown time null and never updates manual fields or existing titles", () => {
  const p = properties({ ...row, minutes: null });
  assert.deepEqual(p["Total Playtime Minutes"], { number: null });
  for (const key of ["Name", "Status", "Rating", "Date", "Played Time", "Cover"]) assert.equal(p[key], undefined);
});
test("dry-run has no Notion writes", async () => {
  const f = fake(); const report = await syncNotion("test", config, [row], false, f.client);
  assert.equal(report.create, 1); assert.equal(report.unmatched, 1); assert.equal(f.writes.length, 0);
});
test("unknown visibility never creates an unmatched row", async () => {
  const f = fake(); const report = await syncNotion("test", config, [{ ...row, visibility: "unknown" }], true, f.client);
  assert.equal(report.skipped, 1); assert.equal(f.writes.length, 0);
});
test("rerun updates by stable key and preserves the existing user relation and title", async () => {
  const f = fake([existing(row, [gameId])]); await syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].action, "update");
  assert.equal(f.writes[0].data.properties.Name, undefined);
  assert.equal(f.writes[0].data.properties.Game, undefined);
  assert.equal(f.records[0].properties.Game.relation[0].id, gameId);
});
test("duplicate existing keys fail before mutation", async () => {
  const f = fake([existing(), existing()]);
  await assert.rejects(syncNotion("test", config, [row], true, f.client)); assert.equal(f.writes.length, 0);
});
test("wrong game source blocks the whole plan before any mutation", async () => {
  const f = fake([], true), binding = { ...config, bindings: { [`PSN:PS5:${row.productId}`]: gameId } };
  await assert.rejects(syncNotion("test", binding, [row], true, f.client)); assert.equal(f.writes.length, 0);
});
test("newly hidden imported platform data is archived without touching the game page", async () => {
  const f = fake([existing()]); await syncNotion("test", config, [{ ...row, visibility: "excluded" }], true, f.client);
  assert.deepEqual(f.writes[0].data, { page_id: recordId, archived: true,
    properties: { Game: { relation: [] }, "Sync Status": { select: { name: "Excluded" } } } });
});
test("unconfirmed editions go to platform review, not a newly created game", async () => {
  const f = fake(); await syncNotion("test", config, [row], true, f.client);
  assert.equal(f.writes[0].data.parent.data_source_id, sourceId);
  assert.equal(f.writes[0].data.properties.Game, undefined);
  assert.deepEqual(f.writes[0].data.properties["Sync Status"], { select: { name: "Needs review" } });
});
test("malformed snapshots and timestamps without a timezone fail before writes", async () => {
  for (const change of [{ minutes: undefined }, { minutes: NaN }, { visibility: "public" }, { provider: "other" }, { sourceUpdated: undefined }]) {
    assert.throws(() => observations([{ ...row, ...change }]));
  }
  assert.throws(() => observations([row], "Nintendo"));
  assert.throws(() => date("2026-01-01T10:00:00"));
  assert.throws(() => durationMinutes("PT" + "9".repeat(350) + "H"));
  const f=fake(); await assert.rejects(syncNotion("test", config, [{ ...row, minutes: NaN }], true, f.client));
  assert.equal(f.writes.length, 0);
});
test("binding conflicts cannot overwrite a user's existing game association", async () => {
  const f=fake([existing(row,[gameId])]);
  await assert.rejects(syncNotion("test", { ...config, bindings: { [`PSN:PS5:${row.productId}`]: sourceId } }, [row], true, f.client));
  assert.equal(f.writes.length, 0);
});
test("a foreign record in a source response is rejected before writes", async () => {
  const value=existing(); value.parent.data_source_id=gamesSourceId;
  const f=fake([value]);await assert.rejects(syncNotion("test",config,[row],true,f.client));
  assert.equal(f.writes.length,0);
});
const policy = () => ({ reviewedAt: new Date().toISOString(), confirmedComplete: true,
  verifiedPublicAppIds: [1,2,3], privateAppIds: [2], hiddenAppIds: [3],
  products: { "1": { type: "Game" }, "2": { type: "Game" }, "3": { type: "Demo" }, "5": { type: "Software" } } });
test("Steam account responses cannot bypass independent hidden and private exclusions", () => {
  const games=[1,2,3,4,5].map(appid=>({appid,name:`Example ${appid}`,playtime_forever:0,rtime_last_played:0}));
  const rows=steamRows({game_count:5,games},{total_count:0},policy(),"test-account",row.syncedAt);
  assert.deepEqual(rows.map(r=>r.visibility),["allowed","excluded","excluded","unknown","excluded"]);
  assert.equal(rows[0].minutes,0);assert.equal(rows[0].lastPlayed,null);assert.equal(rows[0].recentMinutes,0);
});
test("Steam stale privacy, missing counts, duplicate identities and partial results stop collection", () => {
  assert.throws(()=>steamPolicy({...policy(),reviewedAt:"2000-01-01T00:00:00Z"}));
  assert.throws(()=>steamPolicy({...policy(),confirmedComplete:false}));
  const g={appid:1,name:"Example",playtime_forever:5};
  for (const owned of [{}, {game_count:2,games:[g]}, {game_count:2,games:[g,g]}]) {
    assert.throws(()=>steamRows(owned,{total_count:0},policy(),"test-account",row.syncedAt));
  }
  assert.deepEqual(steamRows({game_count:0},{total_count:0},policy(),"test-account",row.syncedAt),[]);
});

async function planned(f: ReturnType<typeof fake>, rows = [row], cfg = config) {
  let plan!: SyncPlan;
  await syncNotion("test", cfg, rows, false, f.client, { onPlan: async p => { plan = p; } });
  return plan;
}
test("missing ownership creates an empty property and is unchanged on the next plan", async () => {
  const f = fake();
  const plan = await planned(f);
  assert.deepEqual(plan.actions[0].properties.Ownership, { rich_text: [] });
  const report = await syncNotion("test", config, [row], true, f.client, { expectedPlan: plan });
  assert.equal(report.verified, 1);
  assert.deepEqual(f.records[0].properties.Ownership.rich_text, []);
  const repeat = await planned(f);
  assert.equal(repeat.counts.unchanged, 1);
  assert.equal(repeat.actions.length, 0);
});
test("ownership transitions clear old placeholders, preserve known values and remain idempotent", async () => {
  for (const [before, after] of [["unknown", null], ["In library", null], [null, "In library"]] as const) {
    const f = fake([existing({ ...row, ownership: before }, [gameId])]);
    const next = { ...row, ownership: after };
    const plan = await planned(f, [next]);
    assert.deepEqual(Object.keys(plan.actions[0].properties).sort(), ["Ownership", "Synced At"]);
    const report = await syncNotion("test", config, [next], true, f.client, { expectedPlan: plan });
    assert.equal(report.verified, 1);
    assert.equal(f.records[0].properties.Ownership.rich_text.map((t: any) => t.plain_text).join(""), after ?? "");
    assert.equal(f.records[0].properties.Name.title[0].plain_text, "User title");
    assert.equal(f.records[0].properties["Review Notes"].rich_text[0].annotations.bold, true);
    assert.equal(f.records[0].properties.Game.relation[0].id, gameId);
    assert.equal((await planned(f, [next])).counts.unchanged, 1);
    assert.equal(f.writes.length, 1);
  }
});
test("readback cannot acknowledge a missing ownership value still stored as unknown", async () => {
  const f = fake([existing({ ...row, ownership: "unknown" })]);
  f.hooks.afterWrite = () => { f.records[0].properties.Ownership = apiProperties(properties({ ...row, ownership: "unknown" })).Ownership; };
  const plan = await planned(f);
  await assert.rejects(syncNotion("test", config, [row], true, f.client, { expectedPlan: plan }), { code: "READBACK_FAILED" });
  assert.equal(f.writes.length, 1);
});
test("identical account data and timestamp-only refreshes make zero writes", async () => {
  for (const change of [{}, { syncedAt: "2026-01-02T00:00:00Z", sourceUpdated: "2026-01-02T00:00:00Z" }]) {
    const f = fake([existing(row, [gameId])]);
    const result = await syncNotion("test", config, [{ ...row, ...change }], true, f.client);
    assert.equal(result.unchanged, 1); assert.equal(result.update, 0); assert.equal(f.writes.length, 0);
    assert.equal(f.records[0].properties["Synced At"].date.start, row.syncedAt);
  }
});
test("a real change only patches differing owned fields and the actual collection time", async () => {
  const f = fake([existing(row, [gameId])]);
  const result = await syncNotion("test", config, [{ ...row, minutes: 61.5, syncedAt: "2026-01-02T00:00:00Z" }], true, f.client);
  assert.deepEqual(Object.keys(f.writes[0].data.properties).sort(), ["Synced At", "Total Playtime Minutes"]);
  assert.equal(result.verified, 1); assert.equal(f.game.properties.Rating.number, 5);
  assert.equal(f.game.properties["Playtime Hours"].formula.number, 1.025);
  assert.equal(f.records[0].properties["Review Notes"].rich_text[0].annotations.bold, true);
});
test("unknown and zero minutes differ in both directions, with correct Game fallback", async () => {
  for (const [before, after] of [[null, 0], [0, null]] as const) {
    const f = fake([existing({ ...row, minutes: before }, [gameId])]);
    await syncNotion("test", config, [{ ...row, minutes: after }], true, f.client);
    assert.equal(f.records[0].properties["Total Playtime Minutes"].number, after);
    assert.equal(f.game.properties["Platform Time Count"].rollup.number, after === null ? 0 : 1);
    assert.equal(f.game.properties["Playtime Hours"].formula.number, after === null ? 7 : 0);
  }
});
test("Notion minute precision and equivalent timezone dates do not cause repeated updates", async () => {
  const prior = { ...row, lastPlayed: "2026-01-01T11:00:00+11:00" };
  const f = fake([existing(prior)]);
  await syncNotion("test", config, [{ ...row, lastPlayed: "2026-01-01T00:00:59Z" }], true, f.client);
  assert.equal(f.writes.length, 0);
  await syncNotion("test", config, [{ ...row, lastPlayed: "2026-01-01T00:01:00Z" }], true, f.client);
  assert.equal(f.writes.length, 1);
});
test("Steam store slug and tracking changes do not overwrite equivalent product URLs", async () => {
  const steam: Observation = { ...row, provider: "Steam", platform: "PC", productId: "1", productUrl: "https://store.steampowered.com/app/1/" };
  const p = existing(steam); p.properties["Product URL"].url = "https://store.steampowered.com/app/1/Example/?snr=tracking";
  const f = fake([p]); await syncNotion("test", config, [steam], true, f.client);
  assert.equal(f.writes.length, 0);
});
test("trophy-only changes are written while absent trophy data preserves verified prior values", async () => {
  const prior = { ...row, earnedTrophies: 2, trophyProgress: 10 };
  const f = fake([existing(prior)]);
  await syncNotion("test", config, [row], true, f.client); assert.equal(f.writes.length, 0);
  await syncNotion("test", config, [{ ...row, earnedTrophies: 3 }], true, f.client);
  assert.deepEqual(Object.keys(f.writes[0].data.properties).sort(), ["Earned Trophies", "Synced At"]);
  assert.equal(f.records[0].properties["Trophy Progress"].number, 10);
});
test("a confirmed binding writes only the new relation and automatic status", async () => {
  const f = fake([existing()]), cfg = { ...config, bindings: { [`PSN:PS5:${row.productId}`]: gameId } };
  await syncNotion("test", cfg, [row], true, f.client);
  assert.deepEqual(Object.keys(f.writes[0].data.properties).sort(), ["Game", "Sync Status", "Synced At"]);
  assert.equal(f.game.properties["Platform Time Count"].rollup.number, 1);
});
test("privacy withdrawal detaches the related record and restores the original hand-entered hours", async () => {
  const f = fake([existing({ ...row, minutes: 120 }, [gameId])]);
  const report = await syncNotion("test", config, [{ ...row, visibility: "excluded" }], true, f.client);
  assert.equal(report.archive, 1); assert.equal(report.verified, 1);
  assert.equal(f.records[0].archived, true); assert.deepEqual(f.records[0].properties.Game.relation, []);
  assert.equal(f.game.properties["Playtime Hours"].formula.number, 7);
});
test("dry-run contains the exact patch and apply refuses a later manual record edit before any write", async () => {
  const rows = [{ ...row, minutes: 5 }], f = fake([existing()]), plan = await planned(f, rows);
  assert.equal(plan.version, 2); assert.deepEqual(Object.keys(plan.actions[0].properties).sort(), ["Synced At", "Total Playtime Minutes"]);
  f.records[0].properties.Name.title[0].text.content = "A new user title";
  await assert.rejects(syncNotion("test", config, rows, true, f.client, { expectedPlan: plan }), { code: "PLAN_CHANGED" });
  assert.equal(f.writes.length, 0);
});
test("input, binding, action and legacy plan changes are rejected before mutation", async () => {
  for (const change of ["input", "binding", "patch", "legacy"] as const) {
    const rows = [{ ...row, minutes: 5 }], f = fake([existing()]), plan = await planned(f, rows);
    let cfg = config, expected: unknown = plan;
    if (change === "input") rows[0].minutes = 6;
    if (change === "binding") cfg = { ...config, bindings: { [`PSN:PS5:${row.productId}`]: gameId } };
    if (change === "patch") plan.actions[0].properties.Name = { title: [{ text: { content: "Forbidden" } }] };
    if (change === "legacy") expected = { digest: "old-format" };
    await assert.rejects(syncNotion("test", cfg, rows, true, f.client, { expectedPlan: expected }),
      { code: change === "legacy" ? "DRY_RUN_REQUIRED" : "PLAN_CHANGED" });
    assert.equal(f.writes.length, 0);
  }
});
test("Game personal edits and new duplicate records invalidate the whole saved plan", async () => {
  for (const change of ["game", "duplicate"] as const) {
    const f = fake([existing(row, [gameId])]), rows = [{ ...row, minutes: 5 }], plan = await planned(f, rows);
    if (change === "game") f.game.properties.Rating.number = 4;
    else f.records.push(structuredClone(f.records[0]));
    await assert.rejects(syncNotion("test", config, rows, true, f.client, { expectedPlan: plan }));
    assert.equal(f.writes.length, 0);
  }
});
test("a concurrent edit immediately before mutation is preserved and stops the write", async () => {
  const f = fake([existing()]);
  f.hooks.retrieve = p => { p.properties.Name.title[0].text.content = "Concurrent edit"; return p; };
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client), { code: "PLAN_CHANGED" });
  assert.equal(f.writes.length, 0);
});
test("incorrect persisted values fail readback and leave a written pending receipt", async () => {
  const f = fake([existing()]), journal: SyncProgress[] = [];
  f.hooks.retrieve = p => { if (f.writes.length) p.properties["Total Playtime Minutes"].number = 999; return p; };
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client,
    { onProgress: async p => { journal.push(p); } }), { code: "READBACK_FAILED" });
  assert.equal(f.writes.length, 1); assert.equal(journal.at(-1)!.pending!.stage, "written");
  assert.equal(journal.at(-1)!.completed.length, 0); assert.equal(journal.at(-1)!.verified, false);
});
test("a stale first readback is retried without repeating the mutation", async () => {
  const f = fake([existing()]); let stale = true;
  f.hooks.retrieve = p => { if (f.writes.length && stale) { stale = false; p.properties["Total Playtime Minutes"].number = 0; } return p; };
  const report = await syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client);
  assert.equal(report.verified, 1); assert.equal(f.writes.length, 1);
});
test("an uncertain committed create is not retried; a new dry-run recovers by stable key", async () => {
  const f = fake(), journal: SyncProgress[] = [], oldPlan = await planned(f);
  f.hooks.afterWrite = () => { throw new Error("transport failed after commit"); };
  await assert.rejects(syncNotion("test", config, [row], true, f.client,
    { expectedPlan: oldPlan, onProgress: async p => { journal.push(p); } }));
  assert.equal(f.writes.length, 1); assert.equal(journal.at(-1)!.pending!.stage, "requesting");
  f.hooks.afterWrite = undefined;
  await assert.rejects(syncNotion("test", config, [row], true, f.client, { expectedPlan: oldPlan }), { code: "PLAN_CHANGED" });
  const newPlan = await planned(f); assert.equal(newPlan.counts.unchanged, 1);
  await syncNotion("test", config, [row], true, f.client, { expectedPlan: newPlan });
  assert.equal(f.writes.length, 1); assert.equal(f.records.length, 1);
});
test("partial batches retain verified progress and a fresh plan writes only the remaining row", async () => {
  const second = { ...row, productId: "PPSA00002_00" }, a = existing(), b = existing(second); b.id = sourceId;
  const f = fake([a, b]), rows = [{ ...row, minutes: 1 }, { ...second, minutes: 2 }], journal: SyncProgress[] = [];
  f.hooks.afterWrite = () => { if (f.writes.length === 2) throw new Error("uncertain second write"); };
  await assert.rejects(syncNotion("test", config, rows, true, f.client, { onProgress: async p => { journal.push(p); } }));
  assert.equal(journal.at(-1)!.completed.length, 1); assert.equal(journal.at(-1)!.pending!.key, syncKey(second));
  // Model a rejected second request rather than its successful commit.
  f.records[1].properties["Total Playtime Minutes"].number = 0; f.hooks.afterWrite = undefined;
  const plan = await planned(f, rows); assert.equal(plan.counts.unchanged, 1); assert.equal(plan.counts.update, 1);
  await syncNotion("test", config, rows, true, f.client, { expectedPlan: plan });
  assert.equal(f.writes.length, 3); assert.equal(f.writes[2].data.page_id, sourceId);
});
test("journal storage failure stops before a mutation", async () => {
  const f = fake([existing()]);
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client,
    { onProgress: async () => { throw new Error("disk full"); } }));
  assert.equal(f.writes.length, 0);
});
test("readback checks unchanged rich text, Game personal fields and derived hours", async () => {
  for (const changed of ["notes", "game", "hours", "rollup"] as const) {
    const f = fake([existing(row, [gameId])]);
    f.hooks.retrieve = p => {
      if (!f.writes.length) return p;
      if (p.id === recordId && changed === "notes") p.properties["Review Notes"].rich_text[0].annotations.bold = false;
      if (p.id === gameId && changed === "game") p.properties.Rating.number = 4;
      if (p.id === gameId && changed === "hours") p.properties["Playtime Hours"].formula.number = 999;
      if (p.id === gameId && changed === "rollup") p.properties["Platform Playtime Minutes"].rollup.number = 999;
      return p;
    };
    await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client), { code: "READBACK_FAILED" });
    assert.equal(f.writes.length, 1);
  }
});
test("final verification detects changes to an unrelated record during a batch", async () => {
  const second = existing({ ...row, productId: "PPSA00002_00" }); second.id = sourceId;
  const f = fake([existing(), second]);
  f.hooks.afterWrite = () => { f.records[1].properties["Total Playtime Minutes"].number = 99; };
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client), { code: "READBACK_FAILED" });
});
test("stable plan comparison ignores property ordering and signed file expiry only", async () => {
  const f = fake([existing()]);
  f.records[0].cover = { type: "file", file: { url: "https://bucket.s3.amazonaws.com/cover?temporary=old", expiry_time: "old" } };
  const rows = [{ ...row, minutes: 5 }], plan = await planned(f, rows);
  f.records[0].cover.file.url = "https://bucket.s3.amazonaws.com/cover?temporary=new";
  f.records[0].cover.file.expiry_time = "new";
  await syncNotion("test", config, rows, true, f.client, { expectedPlan: plan });
  assert.equal(f.writes.length, 1);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
test("paginated records are fully checked before the first mutation", async () => {
  const f = fake([existing()]), query = f.client.dataSources.query.bind(f.client.dataSources);
  f.client.dataSources.query = (async (data: any) => {
    if (data.data_source_id !== sourceId) return query(data);
    return { results: [existing()], has_more: !data.start_cursor, next_cursor: data.start_cursor ? null : "second-page" };
  }) as typeof f.client.dataSources.query;
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client), { code: "DUPLICATE_OR_INVALID_BINDING" });
  assert.equal(f.writes.length, 0);
});
test("incomplete pagination or truncated Game relations cannot become a write plan", async () => {
  const f = fake([existing()]);
  f.client.dataSources.query = (async () => ({ results: [], has_more: true, next_cursor: null })) as unknown as typeof f.client.dataSources.query;
  await assert.rejects(syncNotion("test", config, [row], true, f.client), { code: "NOTION_SCOPE_INCOMPLETE" });
  const g = fake([existing(row, [gameId])]); g.records[0].properties.Game.has_more = true;
  await assert.rejects(syncNotion("test", config, [row], true, g.client), { code: "DUPLICATE_OR_INVALID_BINDING" });
  assert.equal(f.writes.length + g.writes.length, 0);
});
test("missing upstream rows stay untouched and fresh plans preserve unrelated review annotations", async () => {
  const f = fake([existing()]);
  const report = await syncNotion("test", config, [], true, f.client);
  assert.equal(report.archive, 0); assert.equal(f.writes.length, 0);
  const plan = await planned(f, [{ ...row, minutes: 5 }]);
  await syncNotion("test", config, [{ ...row, minutes: 5 }], true, f.client, { expectedPlan: plan });
  assert.equal(f.records[0].properties["Review Notes"].rich_text[0].annotations.bold, true);
});
test("file identity and manual fields called expiry_time remain relevant to exact plans", async () => {
  for (const field of ["cover", "expiry_time"] as const) {
    const f = fake([existing()]), rows = [{ ...row, minutes: 5 }];
    f.records[0].cover = { type: "file", file: { url: "https://bucket.s3.amazonaws.com/cover?temporary=old", expiry_time: "old" } };
    f.records[0].properties.expiry_time = { type: "rich_text", rich_text: [{ text: { content: "Manual value" } }] };
    const plan = await planned(f, rows);
    if (field === "cover") f.records[0].cover.file.url = "https://bucket.s3.amazonaws.com/another-cover?temporary=new";
    else f.records[0].properties.expiry_time.rich_text[0].text.content = "New manual value";
    await assert.rejects(syncNotion("test", config, rows, true, f.client, { expectedPlan: plan }), { code: "PLAN_CHANGED" });
    assert.equal(f.writes.length, 0);
  }
});
test("unknown platform minutes cannot pass readback as a fabricated zero-hour formula", async () => {
  const f = fake([existing()]);
  f.hooks.retrieve = p => {
    if (f.writes.length) p.properties["Playtime Hours"].formula = { type: "number", number: 0 };
    return p;
  };
  await assert.rejects(syncNotion("test", config, [{ ...row, minutes: null }], true, f.client), { code: "READBACK_FAILED" });
  assert.equal(f.writes.length, 1);
});
