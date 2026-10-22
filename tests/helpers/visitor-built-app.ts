// Explicit post-build integration: real Next, loopback HTTP and existing SQL
// migrations/roles in PGlite. No Source/cloud database/COS/Auth transmission.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { Client } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostFixture } from "./incremental-host.ts";
import { mediaIdentity, configDigest } from "../../src/server/database/website-validation.ts";
import { readPublicationState } from "../../src/server/database/incremental-publication.ts";
import { publicationWriter } from "../../src/server/database/publication.ts";
import { installPublishedThumbnails } from "../../scripts/website-sync/published-thumbnail-migration.ts";
import thumbnailProtocol from "../../database/thumbnail-protocol.json" with { type: "json" };
import { visitorMain } from "../../scripts/visitor-acceptance/cli.ts";
import { createPublishedThumbnailRegistrar } from "../../src/server/database/published-thumbnails.ts";
import sharp from "sharp";

const f = await hostFixture(), original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end, log: console.log };
const outputs: string[] = [], childLogs: string[] = [];
try {
  const migration = thumbnailProtocol.migrations[0]; await f.db.exec(await readFile(new URL(`../../supabase/migrations/${migration.file}`, import.meta.url), "utf8"));
  await f.db.query("UPDATE nb_thumbnails.migrations SET digest=$1", [migration.sha256]);
  await installPublishedThumbnails({ query: async <T>(sql: string, values?: unknown[]) => { if (sql.startsWith("--")) { await f.db.exec(sql); return { rows: [] as T[] }; } return f.db.query<T>(sql, values); } });
  const noise = Buffer.alloc(64 * 64 * 3); let seed = 73;
  for (let n = 0; n < noise.length; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise[n] = seed >>> 24; }
  const bytes = await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer(), webp = await sharp(bytes).webp({ quality: 65 }).toBuffer();
  const sha = createHash("sha256").update(bytes).digest("hex"), thumbSha = createHash("sha256").update(webp).digest("hex");
  const record = f.artifact.collection.records.find(r => r.detail.item.kind === "status")!;
  const media = { assetId: mediaIdentity(record.detail.item.id, "cover", sha), ownerPageId: record.detail.item.id, objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png" as const, width: 64, height: 64 };
  const thumbnail = { ...media, assetId: mediaIdentity(media.ownerPageId, `thumbnail:400:${media.assetId}`, thumbSha), sha256: thumbSha, objectKey: `sha256/${thumbSha}`, byteSize: webp.length, mime: "image/webp" as const };
  const selection = [{ parentAssetId: media.assetId, parentSha256: media.sha256, widthCap: 400 as const, thumbnail }], objects = new Map([[media.objectKey, bytes], [thumbnail.objectKey, webp]]);
  record.detail.item.cover = { id: media.assetId, src: `/media/v2/${media.assetId}`, alt: "Synthetic cover", width: 64, height: 64 };
  f.artifact.collection.baseline.recordsDigest = configDigest(f.artifact.collection.records);
  f.artifact.directory.recordsDigest = configDigest([...f.artifact.collection.records].sort((a, b) => a.detail.item.id.localeCompare(b.detail.item.id)));
  const reader = f.open({ connectionString: f.options.database.readerUrl }), writer = f.open({ connectionString: f.options.database.writerUrl });
  const publisher = publicationWriter(writer, "published"), lease = await publisher.begin(randomUUID(), f.digest);
  await publisher.stage(lease, f.artifact.collection.records, [media]); await publisher.promote(lease, { records: f.artifact.collection.records.length, media: 1, complete: true });
  f.artifact.fullRunId = lease.runId; f.artifact.state = await readPublicationState(reader); f.artifact.media = [media];
  await createPublishedThumbnailRegistrar(writer).register({ expectedRevision: f.artifact.state.publicationRevision, ...selection[0] });
  const profile = "CONTENT_PROVIDER=database\nDATABASE_CONTENT_VERSION=2\nDATABASE_PUBLICATION_MODE=published\nMEDIA_PROVIDER=storage\nMEDIA_THUMBNAILS=enabled\nSTORAGE_PROVIDER=cos\nDATABASE_TLS=verify\nDATABASE_READER_URL=" + f.options.database.readerUrl + "\nCOS_BUCKET=fiction-12345\nCOS_REGION=ap-shanghai\nCOS_PREFIX=fiction\nCOS_SECRET_ID=synthetic\nCOS_SECRET_KEY=synthetic\n";
  const files = { config: join(f.root, "guard-config.json"), artifact: join(f.root, "guard-full.json"), thumbnails: join(f.root, "guard-thumbnails.json"), env: join(f.root, "reader.env") };
  for (const [k, path] of Object.entries(files)) await writeFile(path, k === "env" ? profile : JSON.stringify(k === "config" ? f.config : k === "artifact" ? f.artifact : { format: "media-acceptance-thumbnails-v1", entries: selection }), { mode: 0o600 });
  const args = Object.entries(files).flatMap(([k, v]) => [`--${k}`, v]).concat(["--duration-ms", "30000", "--http-requests", "64", "--response-bytes", "67108864", "--sql-queries", "256", "--sql-row-bytes", "8388608"]);
  Client.prototype.connect = function (this: Client) { assert.equal((this as any).connectionParameters.options, "-c default_transaction_read_only=on"); return Promise.resolve(this); } as any;
  Client.prototype.query = function (text: string, values?: unknown[]) { return reader.query(text, values); } as any;
  Client.prototype.end = async function () {} as any;
  console.log = v => outputs.push(String(v));
  const dependencies = { spawn: ((modulePath: string, moduleArgs: string[], options: any) => {
    const child = fork(modulePath, moduleArgs, { ...options, execArgv: ["--import", new URL("./visitor-built-reader.ts", import.meta.url).href], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", b => { if (childLogs.join("").length < 65536) childLogs.push(String(b)); });
    child.stderr?.on("data", b => { if (childLogs.join("").length < 65536) childLogs.push(String(b)); });
    child.on("message", (m: any) => {
      if (m?.type === "fixture-object") { const data = objects.get(m.key); child.send({ type: "fixture-object-reply", id: m.id, result: data?.toString("base64"), error: !data }); return; }
      if (m?.type !== "fixture-sql") return;
      void reader.query(m.text, m.values).then(result => child.send({ type: "fixture-sql-reply", id: m.id, result }), () => child.send({ type: "fixture-sql-reply", id: m.id, error: true }));
    }); return child;
  }) as typeof fork };
  assert.equal(await visitorMain(["plan", ...args], dependencies), 0); const digest = JSON.parse(outputs.at(-1)!).planDigest;
  const operation = join(f.root, "actual-built-operation");
  const pre = ["run", ...args, "--operation", operation, "--phase", "pre", "--plan-sha256", digest, "--deadline-ms", String(Date.now() + 30000), "--port", "3269"];
  const exit = await visitorMain(pre, dependencies), receipt = JSON.parse(await readFile(join(operation, "pre.json"), "utf8"));
  if (exit !== 0) original.log(JSON.stringify({ fixtureReceipt: receipt, fixtureLogs: childLogs }));
  assert.equal(exit, 0); assert.equal(receipt.accountingComplete, true); assert.equal(receipt.report.mediaSampleAvailable, true);
  assert.equal(receipt.report.thumbnail400Verified, true);
  assert.equal(receipt.counters.objectHttpRequests, 3); assert.equal(receipt.counters.visitorHttpRequests, 15);
  assert.equal(receipt.counters.httpRequests, 18); assert.ok(receipt.counters.sqlQueries > 20); assert.ok(receipt.counters.sqlConnectionAttempts <= 3);
  assert.equal(f.counts.sourceCalls, 0); assert.equal(receipt.cloudRouteVerified, false);
  original.log(JSON.stringify({ outcome: "passed", realBuiltNext: true, loopbackHttpRequests: 15, simulatedCosGets: 3, physicalClientQueryCalls: receipt.counters.sqlQueries,
    sqlRowBytes: receipt.counters.sqlRowBytes, responseBytes: receipt.counters.responseBytes, thumbnail400Verified: true, accountingComplete: true, sourceHttp: 0, externalHttp: 0 }));
} finally { Client.prototype.connect = original.connect; Client.prototype.query = original.query; Client.prototype.end = original.end; console.log = original.log; await f.close(); }
