import { PGlite } from "@electric-sql/pglite";

/** Local query-shape data only. Permission/withdrawal tests use the real migrations. */
export async function createSyntheticTimelineDatabase() {
  const db = await PGlite.create();
  await db.exec(`CREATE SCHEMA social_sync;
    CREATE TABLE social_sync.website_collections(collection_key text,account_id text,kind text,collection_id text,collection jsonb);
    CREATE TABLE social_sync.website_publications(work_id text,title text,occurred_at text,publication jsonb);
    CREATE TABLE social_sync.website_collection_members(publication_key text);
    CREATE TABLE social_sync.collection_standalone_overrides(publication_key text,keep_standalone boolean);`);
  return db;
}

export async function seedSyntheticTimeline(db: PGlite, works: number, publications: number) {
  await db.exec("TRUNCATE social_sync.website_publications");
  await db.query(`INSERT INTO social_sync.website_publications
    SELECT 'work-'||w,'Work '||w,'2026-01-01T00:00:00.000Z',jsonb_build_object(
      'id',lpad((w*100+p)::text,64,'0'),'platform','bilibili',
      'publicationId','BV'||lpad((w*100+p)::text,10,'0'),'kind','video',
      'publishedAt','2026-01-01T00:00:00.000Z','observedAt','2026-01-02T00:00:00.000Z',
      'metricsScope','individual-video','originalUrl',null,'linkVerifiedAt',null,
      'metrics',jsonb_build_object('views',1000,'likes',0,'comments',null,'shares',null,'collections',null,'coins',null,'danmaku',null),
      'metricDisplay',jsonb_build_object('likes',null,'comments',null,'shares',null,'collections',null))
    FROM generate_series(1,$1::integer) w CROSS JOIN generate_series(1,$2::integer) p`, [works, publications]);
  await db.exec("ANALYZE social_sync.website_publications");
}
