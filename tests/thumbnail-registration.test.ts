import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { hostFixture } from "./helpers/incremental-host.ts";
import { installPublishedThumbnails } from "../scripts/website-sync/published-thumbnail-migration.ts";
import { createPublishedThumbnailReader } from "../src/server/database/published-thumbnails.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import type { AcceptanceThumbnail } from "../scripts/website-incremental-sync/media-acceptance.ts";
import { planThumbnailRegistration, createThumbnailRegistrationBudget, runThumbnailRegistration, type VerifiedThumbnailCoverage, type RegistrationProgress } from "../scripts/website-incremental-sync/thumbnail-registration.ts";
import { thumbnailRegistrationMain } from "../scripts/website-incremental-sync/thumbnail-registration-cli.ts";
import thumbnailProtocol from "../database/thumbnail-protocol.json" with { type: "json" };
import type { ThumbnailScope } from "../scripts/website-incremental-sync/thumbnail-scope.ts";
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const limits = { durationMs: 10000, sqlRequestBytes: 2 * 1024 ** 2, sqlResponseBytes: 4 * 1024 ** 2 };
async function fixture(count = 1, thumbnailScope?: ThumbnailScope) {
  const f = await hostFixture();
  try {
    const migration = thumbnailProtocol.migrations[0]; await f.db.exec(await readFile(new URL(`../supabase/migrations/${migration.file}`, import.meta.url), "utf8"));
    await f.db.query("UPDATE nb_thumbnails.migrations SET digest=$1", [migration.sha256]);
    await installPublishedThumbnails({ query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("--")) { await f.db.exec(sql); return { rows: [] as T[] }; } return f.db.query<T>(sql, values);
    } });
    const data = Buffer.alloc(128 * 128 * 3); let seed = 73;
    for (let n = 0; n < data.length; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[n] = seed >>> 24; }
    const png = await sharp(data, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer(), webp = await sharp(png).webp({ quality: 65 }).toBuffer();
    const record = f.artifact.collection.records[0], original = { assetId: mediaIdentity(record.detail.item.id, "cover", hash(png)), ownerPageId: record.detail.item.id,
      objectKey: `sha256/${hash(png)}`, sha256: hash(png), byteSize: png.length, mime: "image/png" as const, width: 128, height: 128 };
    const thumbnail = { ...original, assetId: mediaIdentity(original.ownerPageId, `thumbnail:400:${original.assetId}`, hash(webp)),
      objectKey: `sha256/${hash(webp)}`, sha256: hash(webp), byteSize: webp.length, mime: "image/webp" as const };
    const originals = Array.from({ length: count }, (_, i) => ({ ...original,
      assetId: count === 1 ? original.assetId : mediaIdentity(original.ownerPageId, `cover:${i}`, original.sha256) }));
    const candidates: AcceptanceThumbnail[] = originals.map(parent => ({ parentAssetId: parent.assetId, parentSha256: parent.sha256, widthCap: 400,
      thumbnail: { ...thumbnail, assetId: mediaIdentity(parent.ownerPageId, `thumbnail:400:${parent.assetId}`, thumbnail.sha256) } }));
    const reader = f.open({ connectionString: f.options.database.readerUrl }), writer = f.open({ connectionString: f.options.database.writerUrl });
    const publisher = publicationWriter(writer, "published"), lease = await publisher.begin(randomUUID(), f.digest);
    for (let start = 0; start < originals.length; start += 100) {
      await publisher.stage(lease, start === 0 ? f.artifact.collection.records : [], originals.slice(start, start + 100));
    }
    await publisher.promote(lease, { records: 3, media: count, complete: true });
    f.artifact.fullRunId = lease.runId; f.artifact.state = await readPublicationState(reader); f.artifact.media = originals;
    const receipt = JSON.stringify({ fixture: "independent authenticated read", sha256: thumbnail.sha256, byteSize: thumbnail.byteSize });
    const coverage: VerifiedThumbnailCoverage = { format: "published-thumbnail-verified-coverage-v1", origin: "https://fiction-12345.cos.ap-shanghai.myqcloud.com", prefix: "fiction",
      receiptSha256: hash(receipt), independentReaderVerified: true, objects: [{ sha256: thumbnail.sha256, byteSize: thumbnail.byteSize, mime: "image/webp" }] };
    const plan = planThumbnailRegistration(f.config, f.artifact, candidates, coverage, hash(receipt), { ...limits, ...(thumbnailScope ? { thumbnailScope } : {}) });
    return { ...f, reader, writer, original, thumbnail, candidates, coverage, receipt, plan };
  } catch (e) { await f.close(); throw e; }
}
test("offline plan selects same-full verified objects, excludes old or changed parents and binds receipt evidence", async () => {
  const f = await fixture();
  try {
    assert.equal(f.plan.summary.selectedBindings, 1); assert.equal(f.plan.summary.sqlQueries, 21); assert.equal(f.plan.summary.httpRequests, 0);
    const historical = { ...f.candidates[0], parentAssetId: `a1.${"0".repeat(64)}` };
    const p = planThumbnailRegistration(f.config, f.artifact, [...f.candidates, historical], f.coverage, hash(f.receipt), limits);
    assert.equal(p.summary.excludedHistoricalBindings, 1);
    assert.equal(planThumbnailRegistration(f.config, f.artifact, [{ ...f.candidates[0], parentSha256: "0".repeat(64) }], f.coverage, hash(f.receipt), limits).summary.changedParents, 1);
    assert.equal(planThumbnailRegistration(f.config, f.artifact, f.candidates, { ...f.coverage, objects: [] }, hash(f.receipt), limits).summary.unverifiedBindings, 1);
    assert.throws(() => planThumbnailRegistration(f.config, f.artifact, f.candidates, f.coverage, "0".repeat(64), limits));
    assert.throws(() => planThumbnailRegistration(f.config, f.artifact, f.candidates, { ...f.coverage, independentReaderVerified: false } as unknown as VerifiedThumbnailCoverage, hash(f.receipt), limits));
  } finally { await f.close(); }
});
test("explicit scope registers more than 197 bindings once, retains every parent and one shared object", async () => {
  const thumbnailScope: ThumbnailScope = { format: "thumbnail-scope-v1", maxBindings: 198, maxObjects: 1, maxBytes: 1024 ** 2 };
  const f = await fixture(198, thumbnailScope);
  try {
    assert.throws(() => planThumbnailRegistration(f.config, f.artifact, f.candidates, f.coverage, hash(f.receipt), limits));
    assert.equal(f.plan.thumbnails.length, 198); assert.equal(f.plan.summary.sqlQueries, 612);
    const budget = createThumbnailRegistrationBudget(f.plan);
    try {
      const result = await runThumbnailRegistration(f.plan, { reader: f.reader, writer: f.writer,
        readerUrl: f.options.database.readerUrl, writerUrl: f.options.database.writerUrl, budget, progress: async () => {} });
      assert.equal(result.acknowledgedWrites, 198); assert.equal(result.verifiedBindings, 198);
      assert.equal(budget.statistics().sqlQueries, 612);
    } finally { budget.close(); }
    assert.throws(() => planThumbnailRegistration(f.config, f.artifact, f.candidates, f.coverage, hash(f.receipt),
      { ...limits, thumbnailScope: { ...thumbnailScope, maxBindings: 197 } }));
    const changed = structuredClone(f.plan); changed.thumbnailScope!.maxBindings++;
    const budget2 = createThumbnailRegistrationBudget(f.plan); let queried = false;
    try {
      await assert.rejects(runThumbnailRegistration(changed, { reader: { query: async () => { queried = true; throw Error(); } },
        writer: f.writer, readerUrl: f.options.database.readerUrl, writerUrl: f.options.database.writerUrl,
        budget: budget2, progress: async () => {} }), { code: "THUMBNAIL_REGISTRATION_PLAN_CHANGED" });
      assert.equal(queried, false);
    } finally { budget2.close(); }
  } finally { await f.close(); }
});
test("expanded byte scope is explicit, bound to the digest, and rejects incomplete or excessive coverage", async () => {
  const f = await fixture();
  try {
    const thumbnailScope: ThumbnailScope = { format: "thumbnail-scope-v1", maxBindings: 1, maxObjects: 1, maxBytes: 16 * 1024 ** 2 };
    const artifact = structuredClone(f.artifact); artifact.media[0].byteSize = 20 * 1024 ** 2;
    const candidates = structuredClone(f.candidates); candidates[0].thumbnail.byteSize = 16 * 1024 ** 2;
    const coverage = structuredClone(f.coverage); coverage.objects[0].byteSize = 16 * 1024 ** 2;
    assert.throws(() => planThumbnailRegistration(f.config, artifact, candidates, coverage, hash(f.receipt), limits));
    const p = planThumbnailRegistration(f.config, artifact, candidates, coverage, hash(f.receipt), { ...limits, thumbnailScope });
    assert.equal(p.summary.selectedBindings, 1); assert.equal(p.summary.verifiedObjectBytes, thumbnailScope.maxBytes);
    assert.notEqual(p.digest, planThumbnailRegistration(f.config, artifact, candidates, coverage, hash(f.receipt),
      { ...limits, thumbnailScope: { ...thumbnailScope, maxBytes: thumbnailScope.maxBytes + 1 } }).digest);
    assert.throws(() => planThumbnailRegistration(f.config, artifact, candidates, coverage, hash(f.receipt),
      { ...limits, thumbnailScope: { ...thumbnailScope, maxBytes: thumbnailScope.maxBytes - 1 } }));
    assert.throws(() => planThumbnailRegistration(f.config, artifact, candidates, { ...coverage, objects: [...coverage.objects, { sha256: "a".repeat(64), byteSize: 1, mime: "image/webp" }] },
      hash(f.receipt), { ...limits, thumbnailScope }));
    assert.throws(() => planThumbnailRegistration(f.config, artifact, candidates, { ...coverage, independentReaderVerified: false } as unknown as VerifiedThumbnailCoverage,
      hash(f.receipt), { ...limits, thumbnailScope }));
  } finally { await f.close(); }
});
test("real restricted SQL registers once and independently verifies; repetition and verify-only perform no mutation", async () => {
  const f = await fixture();
  try {
    for (const step of ["first", "repeat", "verify"] as const) {
      const budget = createThumbnailRegistrationBudget(f.plan), progress: RegistrationProgress[] = [];
      try {
        const proof = await runThumbnailRegistration(f.plan, { reader: f.reader, writer: f.writer, readerUrl: f.options.database.readerUrl, writerUrl: f.options.database.writerUrl,
          budget, verifyOnly: step === "verify", progress: async p => { progress.push(p); } });
        assert.equal(proof.verifiedBindings, 1); assert.equal(proof.writeRequests, step === "first" ? 1 : 0);
        assert.equal(budget.statistics().sqlQueries, step === "first" ? 21 : 20);
        if (step === "first") assert.ok(progress.some(p => p.inFlight !== null && p.acknowledgedWrites === 0));
        assert.deepEqual(await readPublicationState(f.reader), f.artifact.state);
      } finally { budget.close(); }
    }
    assert.deepEqual((await createPublishedThumbnailReader(f.reader)(f.original.assetId, 400))!.thumbnail, f.thumbnail);
  } finally { await f.close(); }
});
test("withdrawal, parent change, wrong identity and exhausted request budget fail before registration", async t => {
  for (const scenario of ["ancestor", "parent", "writer-as-reader", "request-limit", "stale-plan"] as const) await t.test(scenario, async () => {
    const f = await fixture(); let writes = 0;
    const plan = scenario === "request-limit" ? planThumbnailRegistration(f.config, f.artifact, f.candidates, f.coverage, hash(f.receipt), { ...limits, sqlRequestBytes: 1 }) : structuredClone(f.plan);
    const budget = createThumbnailRegistrationBudget(plan);
    try {
      if (scenario === "ancestor") await f.db.query("INSERT INTO nb_v2.denied VALUES($1)", [f.artifact.collection.records.find(r => r.detail.item.kind === "course")!.detail.item.id]);
      if (scenario === "parent") await f.db.query("UPDATE nb_v2.media SET descriptor=jsonb_set(descriptor,'{sha256}',to_jsonb($1::text))", ["a".repeat(64)]);
      if (scenario === "stale-plan") plan.summary.selectedBindings++;
      await assert.rejects(runThumbnailRegistration(plan, { reader: scenario === "writer-as-reader" ? f.writer : f.reader,
        writer: { query: (sql, values) => { if (sql.includes("register_thumbnail($1")) writes++; return f.writer.query(sql, values); } },
        readerUrl: f.options.database.readerUrl, writerUrl: f.options.database.writerUrl, budget, progress: async () => {} }));
      assert.equal(writes, 0);
    } finally { budget.close(); await f.close(); }
  });
});
test("lost SQL acknowledgement preserves an in-flight write and verification resolves it without another registration", async () => {
  const f = await fixture(); const budget = createThumbnailRegistrationBudget(f.plan); let writes = 0, latest: RegistrationProgress | undefined;
  try {
    await assert.rejects(runThumbnailRegistration(f.plan, { reader: f.reader, writer: { query: async <T>(sql: string, values?: unknown[]) => {
      const value = await f.writer.query<T>(sql, values); if (sql.includes("register_thumbnail($1")) { writes++; throw Error("Synthetic lost acknowledgement"); } return value;
    } }, readerUrl: f.options.database.readerUrl, writerUrl: f.options.database.writerUrl, budget, progress: async p => { latest = p; } }));
    assert.equal(writes, 1); assert.equal(latest!.writeRequests, 1); assert.equal(latest!.acknowledgedWrites, 0); assert.notEqual(latest!.inFlight, null);
    budget.close(); const recovery = createThumbnailRegistrationBudget(f.plan);
    try { assert.equal((await runThumbnailRegistration(f.plan, { reader: f.reader, writer: f.writer, readerUrl: f.options.database.readerUrl,
      writerUrl: f.options.database.writerUrl, budget: recovery, verifyOnly: true, progress: async () => {} })).verifiedBindings, 1); }
    finally { recovery.close(); }
    assert.equal(writes, 1);
  } finally { budget.close(); await f.close(); }
});
test("actual CLI has zero HTTP, uses canonical lock and private progress, rejects replay and never inherits object credentials", async () => {
  const f = await fixture(), original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end, fetch, log: console.log };
  const output: string[] = []; let connections = 0, closes = 0, requests = 0;
  Client.prototype.connect = (async function (this: Client) { connections++; return this; }) as typeof original.connect;
  Client.prototype.query = (function (this: Client & { connectionParameters: { options: string } }, sql: string, values?: unknown[]) {
    return (this.connectionParameters.options === "-c default_transaction_read_only=on" ? f.reader : f.writer).query(sql, values);
  }) as typeof original.query;
  Client.prototype.end = (async () => { closes++; }) as typeof original.end;
  globalThis.fetch = async () => { requests++; assert.fail("No HTTP permitted"); }; console.log = value => output.push(String(value));
  const privateInputs = { artifact: f.artifact, thumbnails: { format: "media-acceptance-thumbnails-v1", entries: f.candidates }, coverage: f.coverage };
  for (const [name, data] of Object.entries(privateInputs)) await writeFile(join(f.root, name + ".json"), JSON.stringify(data), { mode: 0o600 });
  await writeFile(join(f.root, "coverage-receipt.json"), f.receipt, { mode: 0o600 });
  const state = join(f.root, "state"), runtime = join(f.root, "runtime.json"); await writeFile(runtime, JSON.stringify({ format: "website-v2-runtime-1", privateRoot: f.root, stateDir: state }), { mode: 0o600 });
  // This scenario tests cancellation and late replies, not elapsed deadlines.
  // Allow bounded headroom for durable fixture I/O on the background runner.
  const cliDurationMs = 60000;
  const args = ["--config", join(f.root, "config.json"), "--artifact", join(f.root, "artifact.json"), "--thumbnails", join(f.root, "thumbnails.json"),
    "--coverage", join(f.root, "coverage.json"), "--coverage-receipt", join(f.root, "coverage-receipt.json"), "--duration-ms", String(cliDurationMs), "--sql-request-bytes", "2097152", "--sql-response-bytes", "4194304"];
  const env = { NODE_ENV: "test" as const, SYNC_DATABASE_URL: f.options.database.writerUrl, SYNC_READER_DATABASE_URL: f.options.database.readerUrl, DATABASE_TLS: "verify" };
  try {
    assert.equal(await thumbnailRegistrationMain(["--help"], { NODE_ENV: "test" }), 0);
    assert.equal(await thumbnailRegistrationMain(["plan", ...args], { NODE_ENV: "test" }), 0); const digest = JSON.parse(output.at(-1)!).planDigest; assert.equal(connections, 0);
    const scopePath = join(f.root, "scope.json"), scope = { format: "thumbnail-scope-v1", maxBindings: 200, maxObjects: 200, maxBytes: 32 * 1024 ** 2 };
    await writeFile(scopePath, JSON.stringify(scope), { mode: 0o600 });
    const scopedArgs = [...args, "--thumbnail-scope", scopePath];
    assert.equal(await thumbnailRegistrationMain(["plan", ...scopedArgs], { NODE_ENV: "test" }), 0);
    const scopedDigest = JSON.parse(output.at(-1)!).planDigest; assert.notEqual(scopedDigest, digest); assert.equal(connections, 0);
    await writeFile(scopePath, JSON.stringify({ ...scope, maxBytes: scope.maxBytes - 1 }), { mode: 0o600 });
    await assert.rejects(thumbnailRegistrationMain(["register", ...scopedArgs, "--plan-sha256", scopedDigest, "--runtime", runtime,
      "--state-dir", state, "--receipt", join(f.root, "scope-changed.json"), "--deadline-ms", String(Date.now()+10000)], env),
      { code: "THUMBNAIL_REGISTRATION_PLAN_CHANGED" });
    await writeFile(scopePath, JSON.stringify({ ...scope, maxBindings: 4001 }), { mode: 0o600 });
    await assert.rejects(thumbnailRegistrationMain(["plan", ...scopedArgs], { NODE_ENV: "test" }), { code: "THUMBNAIL_REGISTRATION_INPUT_INVALID" });
    assert.equal(connections, 0); assert.equal(requests, 0);
    const runArgs = [...args, "--plan-sha256", digest, "--runtime", runtime, "--state-dir", state, "--receipt", join(f.root, "operation.json"), "--deadline-ms", String(Date.now() + cliDurationMs)];
    assert.equal(await thumbnailRegistrationMain(["register", ...runArgs], env), 0); const result = JSON.parse(output.at(-1)!);
    assert.equal(result.httpRequests, 0); assert.equal(requests, 0); assert.equal(result.acknowledgedWrites, 1); assert.equal(connections, 2); assert.equal(closes, 2);
    const receipt = JSON.parse(await readFile(join(f.root, "operation.json"), "utf8")); assert.equal(receipt.verifiedBindings, 1); assert.equal(receipt.possiblePartialRegistration, false);
    assert.equal((await readdir(state)).includes("worker.lock"), false);
    assert.equal(await thumbnailRegistrationMain(["register", ...runArgs], env), 1); assert.equal(connections, 2);
    await assert.rejects(thumbnailRegistrationMain(["register", ...runArgs], { ...env, COS_SECRET_KEY: "fixture-secret" })); assert.equal(connections, 2);
    const wrongTarget = new URL(env.SYNC_READER_DATABASE_URL); wrongTarget.hostname = "wrong-target.invalid";
    await assert.rejects(thumbnailRegistrationMain(["register", ...runArgs], { ...env, SYNC_READER_DATABASE_URL: wrongTarget.href }), { code: "THUMBNAIL_REGISTRATION_TARGET_INVALID" }); assert.equal(connections, 2);
    // Commit succeeds while the native reply is still pending, then cancel.
    // Final counters must include its late rows and the durable receipt must
    // retain uncertainty; the CLI must not issue another registration.
    await f.db.query("DELETE FROM nb_thumbnails.media"); let lateReplies = 0, priorRows = 0, lateRows = 0;
    Client.prototype.query = (function (this: Client & { connectionParameters: { options: string } }, sql: string, values?: unknown[]) {
      const port = this.connectionParameters.options === "-c default_transaction_read_only=on" ? f.reader : f.writer;
      return port.query(sql, values).then(async value => {
        if (sql.includes("register_thumbnail($1")) { lateReplies++;
          priorRows = JSON.parse(await readFile(join(f.root, "cancelled-operation.json"), "utf8")).counters.sqlResponseBytes;
          lateRows = Buffer.byteLength(JSON.stringify(value.rows)); queueMicrotask(() => process.emit("SIGTERM")); await new Promise(done => setTimeout(done, 10)); }
        return value;
      });
    }) as typeof original.query;
    const cancelledArgs = [...runArgs]; cancelledArgs[cancelledArgs.indexOf("--receipt") + 1] = join(f.root, "cancelled-operation.json");
    // This is a new execution; earlier replay and rejection checks must not
    // consume the cancellation execution's absolute deadline.
    cancelledArgs[cancelledArgs.indexOf("--deadline-ms") + 1] = String(Date.now() + cliDurationMs);
    assert.equal(await thumbnailRegistrationMain(["register", ...cancelledArgs], env), 1);
    const cancelled = JSON.parse(output.at(-1)!); assert.equal(cancelled.errorCode, "THUMBNAIL_REGISTRATION_CANCELLED"); assert.equal(cancelled.possiblePartialRegistration, true);
    assert.equal(cancelled.acknowledgedWrites, 0); assert.equal(lateReplies, 1); assert.equal(connections, 4); assert.equal(closes, 4);
    assert.equal(cancelled.counters.sqlResponseBytes, priorRows + lateRows);
    const saved = JSON.parse(await readFile(join(f.root, "cancelled-operation.json"), "utf8")); assert.notEqual(saved.inFlight, null);
    assert.deepEqual((await createPublishedThumbnailReader(f.reader)(f.original.assetId, 400))!.thumbnail, f.thumbnail);
    for (const secret of [f.root, f.original.assetId, f.options.database.writerUrl, f.options.database.readerUrl]) assert.equal(output.join("\n").includes(secret), false);
  } finally { Client.prototype.connect = original.connect; Client.prototype.query = original.query; Client.prototype.end = original.end; globalThis.fetch = original.fetch; console.log = original.log; await f.close(); }
});
