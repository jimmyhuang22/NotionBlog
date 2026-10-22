import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { config, hash, publicationKey } from "../../scripts/social-sync/model.ts";
import { observation } from "../../scripts/social-sync/bilibili.ts";
import { collectionKey } from "../../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./social-collection-samples.ts";
import { createCoverWriter } from "../../scripts/social-media/cloud.ts";
const at = () => new Date(Date.now() - 1000).toISOString();
export async function coverTestImage(width = 1200, height = 720) { return sharp({ create: { width, height, channels: 3, background: "#3b7391" } }).png().toBuffer(); }
export async function coverTestEngine(t: { after: (callback: () => Promise<void>) => void }, rotation = true) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE nb_reader;");
  for (const name of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql",
    "20261012054647_social_collections_v1.sql", "20261012213401_social_retained_projections.sql", "20261013214552_social_collection_follow_members.sql", "20261014014825_social_work_covers.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  if (rotation) await db.exec(await readFile(new URL("../../supabase/migrations/20261018134559_social_cover_rotation.sql", import.meta.url), "utf8"));
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values); }) });
  const reader = role("nb_social_reader"), worker = role("nb_social_worker"), media = role("nb_social_media_worker");
  const add = async (id: string, workId: string, cover: string | null = "https://i0.hdslb.com/example.png", published = "2026-01-01T00:00:00.000Z") => {
    const target = config({ version: 1, publications: [{ platform: "bilibili", workId, accountId: "10001", url: `https://www.bilibili.com/video/${id}/` }] })[0]!;
    const row = observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: id, owner: { mid: 10001 }, title: "Fictional video", pic: cover,
      pubdate: Date.parse(published) / 1000, stat: { view: 10, like: 0 } } })};</script>`, target, at());
    await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [row.platform, row.accountId, row.publicationId, row.workId]);
    await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    await db.query("INSERT INTO social_sync.works(work_id,title,occurred_at,approved) VALUES($1,'Reviewed work',$2,true)", [workId, published]);
    await db.query(`INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256)
      VALUES($1,$2,true,now(),'video',$3,$3)`, [publicationKey(row), workId, hash(JSON.stringify(row))]);
    await db.query("INSERT INTO social_sync.website_visibility(publication_key,work_id,approved,checked_at,valid_until) VALUES($1,$2,true,now(),now()+interval '1 hour')", [publicationKey(row), workId]);
    return row;
  };
  const collection = async (kind: "season" | "multi-part" = "season") => {
    const row = exampleCollectionSnapshot(at(), kind), key = collectionKey(row.target);
    await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)", [row.target.accountId, kind, row.target.collectionId]);
    await worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [key, hash(JSON.stringify(row)), JSON.stringify(row)]);
    await db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
      SELECT collection_key,true,now(),'Reviewed collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`, [key]);
    return row;
  };
  return { db, role, reader, worker, media, add, collection, writer: createCoverWriter(media) };
}
