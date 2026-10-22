// Synthetic process-boundary fixture. All source/media reads are offline.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../../scripts/notion-sync/demo.ts";
import type { BlockObjectResponse } from "@notionhq/client";
import { createCollectionCapture } from "../../scripts/website-sync/collection-capture.ts";
import { prepareCollectionResume } from "../../scripts/website-sync/collection-revalidation.ts";
import { runWebsiteSync, websitePolicy } from "../../scripts/website-sync/worker.ts";
import { createWebsiteWriter } from "../../src/server/database/website-writer.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import protocol from "../../database/qualified-revalidation-protocol.json" with { type: "json" };

import freshProtocol from "../../database/fresh-qualification-protocol.json" with { type: "json" };

const [root, phase, qualification = "original"] = process.argv.slice(2), db = await PGlite.create(join(root, "db"));
try {
  const demo = createDemo(2), config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] });
  demo.blocks.set(demoId(1000), [{ ...demoParagraph(demoId(9000), demoId(1000), ""), type: "image",
    image: { type: "external", external: { url: "https://assets.example.test/synthetic.heic" }, caption: [] } } as BlockObjectResponse]);
  if (phase === "first") {
    await db.exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8"));
    await db.exec(await readFile(new URL(`../../supabase/migrations/${freshProtocol.migration.file}`, import.meta.url), "utf8"));
    const policy = await websitePolicy(demo.client, config, 3600);
    await db.query("SELECT nb_v2_api.configure_policy($1,3600,$2::jsonb,$3::jsonb)", [policy.configDigest, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  }
  const writer = createWebsiteWriter(db), runId = randomUUID(), identity = { runId, releaseCommit: "a".repeat(40), sourceSha256: "b".repeat(64), configDigest: configDigest(config) };
  const capture = await createCollectionCapture(join(root, `${phase}-capture`), identity);
  let puts = 0, reads = 0, bound: unknown;
  if (phase === "second" && qualification === "fresh") await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 hour' WHERE status='failed'");
  const resume = phase === "second" ? await prepareCollectionResume({ directory: join(root, "first-capture"),
    identity: JSON.parse(await readFile(join(root, "identity.json"), "utf8")), db, qualification: qualification as "original" | "fresh", onBound: async receipt => { bound = receipt; } }) : undefined;
  if (phase === "first") await writeFile(join(root, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  const client = { ...demo.client,
    getDataSource: async (id: string) => ({ ...await demo.client.getDataSource(id), request_id: `${phase}-response` }),
    getPage: async (id: string) => { const page = await demo.client.getPage(id); return page && { ...page, request_id: `${phase}-response` }; },
    listBlocks: async (id: string) => {
    if (phase === "first" && id === demoId(1001)) throw new Error("Synthetic interruption");
    return demo.client.listBlocks(id);
  } };
  let result: unknown, resumePlan: unknown;
  try { result = await runWebsiteSync({ client, config, mode: "publish", writer: { ...writer, begin: async (_id, digest) => writer.begin(runId, digest) },
    captureCollection: capture, resumeCollection: resume, onResumePlan:async plan=>{resumePlan=plan;}, storage: { put: async () => { puts++; }, read: async () => { reads++; return DEMO_PNG; } },
    mediaSources: { stage: async () => {} }, download: async () => ({ bytes: DEMO_PNG, mime: "image/png", transformed: true }) }); }
  catch (error) { if (phase !== "first" || !(error instanceof Error) || error.message !== "Synthetic interruption") throw error; }
  const state = (await db.query("SELECT current_run,lease_run FROM nb_v2.state")).rows[0];
  console.log(JSON.stringify({ pid: process.pid, result, resumePlan, capture: capture.statistics(), puts, reads, bound, state }));
} finally { await db.close(); }
