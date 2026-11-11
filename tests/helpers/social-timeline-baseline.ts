// Offline comparison only. Unchanged query from cf9bcfe71c3de6b87ce0d52c31adc975e3b6529d.
// Keep the former per-work LATERAL scan and its 501/21 rejection sentinels.
export function baselineSocialTimelineSql(playback = false) { return `WITH collections AS MATERIALIZED (
    SELECT c.collection_key,c.account_id,c.kind,c.collection_id,c.collection||jsonb_build_object(
      'latestMemberPublishedAt',CASE WHEN c.kind='multi-part' THEN c.collection->>'latestMemberPublishedAt' ELSE ${playback ? "playback.published_at" : "c.collection->>'latestMemberPublishedAt'"} END,
      'latestMemberUrl',CASE WHEN c.kind='multi-part' THEN c.collection->>'originalUrl' ELSE ${playback ? "playback.outbound_url" : "NULL"} END,
      'latestMemberLinkVerifiedAt',CASE WHEN c.kind='multi-part' THEN c.collection->>'linkVerifiedAt' ELSE ${playback ? "playback.link_verified_at" : "NULL"} END
    ) AS collection
    FROM social_sync.website_collections c ${playback ? "LEFT JOIN social_sync.website_collection_playbacks playback USING(collection_key)" : ""}
  ),
  -- Candidates and each work's bounded aggregate reuse the same RLS-filtered publications.
  publications AS MATERIALIZED (
    SELECT * FROM social_sync.website_publications p WHERE NOT EXISTS (
      SELECT 1 FROM social_sync.website_collection_members m WHERE m.publication_key=p.publication->>'id'
        AND NOT EXISTS(SELECT 1 FROM social_sync.collection_standalone_overrides o WHERE o.publication_key=m.publication_key AND o.keep_standalone)
    )
  ), candidates AS (
    SELECT coalesce(p.work_id,c.collection->>'id') AS id,CASE WHEN c.collection_key IS NULL THEN p.title ELSE c.collection->>'title' END AS title,
      CASE WHEN p.work_id IS NOT NULL THEN p.occurred_at ELSE c.collection->>'firstPublishedAt' END AS occurred_at,
      c.collection,CASE WHEN c.collection_key IS NULL THEN NULL ELSE jsonb_build_object('accountId',c.account_id,'collectionId',c.collection_id) END AS identity,
      coalesce(c.collection->'activity'->>'at',CASE WHEN p.work_id IS NOT NULL THEN p.occurred_at ELSE c.collection->>'firstPublishedAt' END) AS timeline_at
    FROM (SELECT work_id,title,occurred_at FROM publications GROUP BY work_id,title,occurred_at) p
      FULL JOIN collections c ON c.collection->>'id'=p.work_id
  ), selected AS MATERIALIZED (SELECT * FROM candidates ORDER BY timeline_at DESC NULLS LAST,id LIMIT 501)
  SELECT jsonb_build_object('id',s.id,'title',s.title,'occurredAt',s.occurred_at,'collection',s.collection,'collectionIdentity',s.identity,
    'publications',coalesce(p.items,'[]'::jsonb)) AS work FROM selected s CROSS JOIN LATERAL (
      SELECT jsonb_agg(publication ORDER BY publication->>'platform',publication->>'id') AS items FROM (
        SELECT publication FROM publications WHERE work_id=s.id ORDER BY publication->>'platform',publication->>'id' LIMIT 21
      ) bounded
    ) p ORDER BY s.timeline_at DESC NULLS LAST,s.id`; }
