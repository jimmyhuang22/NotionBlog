-- Add truthful JSON provenance without changing old source versions, roles or projections.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='social_sync.valid_observation(jsonb)'::regprocedure AND md5(prosrc)='507727d1dff71a11906be9cff991a93a' AND NOT prosecdef AND provolatile='i' AND proconfig=ARRAY['search_path=pg_catalog']::text[]) THEN RAISE EXCEPTION 'NB_BILIBILI_API_BASE_CHANGED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='social_sync.valid_collection(jsonb)'::regprocedure AND md5(prosrc)='c8dfaafdaabd6585eab4a083a430b250' AND NOT prosecdef AND provolatile='i' AND proconfig=ARRAY['search_path=pg_catalog']::text[]) THEN RAISE EXCEPTION 'NB_BILIBILI_API_BASE_CHANGED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM social_sync.meta WHERE singleton AND version=1) OR NOT EXISTS(SELECT 1 FROM social_sync.collection_meta WHERE singleton AND version=1) THEN RAISE EXCEPTION 'NB_BILIBILI_API_PROTOCOL_INVALID'; END IF;
END $$;
ALTER TABLE social_sync.meta ADD COLUMN bilibili_api_version smallint NOT NULL DEFAULT 0 CHECK(bilibili_api_version IN (0,1));
ALTER TABLE social_sync.collection_meta ADD COLUMN bilibili_api_version smallint NOT NULL DEFAULT 0 CHECK(bilibili_api_version IN (0,1));

CREATE OR REPLACE FUNCTION social_sync.valid_observation(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE xhs boolean; keys text[]; m text; v jsonb; s text; BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'platform' NOT IN ('bilibili','xiaohongshu') THEN RETURN false; END IF;
  xhs:=p->>'platform'='xiaohongshu';
  keys:=ARRAY['version','platform','workId','accountId','publicationId','kind','originalUrl','title','description','coverUrl',
    'publishedAt','observedAt','metricsScope','metrics','collection','source','responseSha256','websitePublicationApproved'];
  IF xhs THEN keys:=keys||ARRAY['updatedAt','metricDisplay']; END IF;
  IF NOT (p ?& keys) OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) THEN RETURN false; END IF;
  FOREACH m IN ARRAY ARRAY['platform','workId','accountId','publicationId','kind','originalUrl','title','observedAt','metricsScope','source','responseSha256'] LOOP
    IF jsonb_typeof(p->m) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF p->'websitePublicationApproved' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p->'workId')<>'string' OR
    p->>'workId' !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR jsonb_typeof(p->'accountId')<>'string' OR jsonb_typeof(p->'publicationId')<>'string' OR
    jsonb_typeof(p->'title')<>'string' OR length(btrim(p->>'title'))=0 OR length(p->>'title')>1000 OR
    jsonb_typeof(p->'responseSha256')<>'string' OR p->>'responseSha256' !~ '^[a-f0-9]{64}$' OR
    jsonb_typeof(p->'observedAt')<>'string' OR NOT social_sync.valid_time(p->'observedAt') OR NOT social_sync.valid_time(p->'publishedAt') THEN RETURN false; END IF;
  IF xhs THEN
    IF p->'version'<>'2'::jsonb OR p->>'kind' NOT IN ('video','image-note') OR p->>'metricsScope'<>'individual-note' OR
      p->>'source' NOT IN ('browser-note-state','public-note-page-ssr') OR p->>'accountId' !~ '^[a-f0-9]{24}$' OR p->>'publicationId' !~ '^[a-f0-9]{24}$' OR
      p->'collection'<>'null'::jsonb OR p->'description'<>'null'::jsonb OR NOT social_sync.valid_time(p->'updatedAt') OR
      p->>'originalUrl'<>'https://www.xiaohongshu.com/explore/'||(p->>'publicationId') THEN RETURN false; END IF;
  ELSE
    IF p->'version'<>'1'::jsonb OR p->>'kind'<>'video' OR p->>'metricsScope'<>'individual-video' OR p->>'source' NOT IN ('public-video-page-ssr','public-video-api-json') OR
      p->>'accountId' !~ '^[1-9][0-9]{0,19}$' OR p->>'publicationId' !~ '^BV[0-9A-Za-z]{10}$' OR
      p->>'originalUrl'<>'https://www.bilibili.com/video/'||(p->>'publicationId')||'/' THEN RETURN false; END IF;
    IF p->'description'<>'null'::jsonb AND (jsonb_typeof(p->'description')<>'string' OR length(btrim(p->>'description'))=0 OR length(p->>'description')>20000) THEN RETURN false; END IF;
    IF p->'collection'<>'null'::jsonb THEN
      v:=p->'collection';
      IF jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['id','title','episodeCount']) OR (SELECT count(*) FROM jsonb_object_keys(v))<>3 OR
        jsonb_typeof(v->'id')<>'string' OR v->>'id' !~ '^[1-9][0-9]{0,19}$' OR jsonb_typeof(v->'title')<>'string' OR
        length(btrim(v->>'title'))=0 OR length(v->>'title')>1000 OR NOT social_sync.valid_count(v->'episodeCount') THEN RETURN false; END IF;
    END IF;
  END IF;
  IF p->'coverUrl'<>'null'::jsonb THEN
    s:=p->>'coverUrl';
    IF jsonb_typeof(p->'coverUrl')<>'string' OR length(s)>2048 OR
      (xhs AND s !~ '^https://[a-z0-9-]+\.xhscdn\.com/') OR (NOT xhs AND s !~ '^https://i[0-9]+\.hdslb\.com/') THEN RETURN false; END IF;
  END IF;
  v:=p->'metrics';
  IF jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['views','likes','comments','shares','collections','coins','danmaku']) OR (SELECT count(*) FROM jsonb_object_keys(v))<>7 THEN RETURN false; END IF;
  FOREACH m IN ARRAY ARRAY['views','likes','comments','shares','collections','coins','danmaku'] LOOP
    IF NOT social_sync.valid_count(v->m) THEN RETURN false; END IF;
  END LOOP;
  IF xhs THEN
    IF v->'views'<>'null'::jsonb OR v->'coins'<>'null'::jsonb OR v->'danmaku'<>'null'::jsonb OR jsonb_typeof(p->'metricDisplay')<>'object' OR
      NOT(p->'metricDisplay' ?& ARRAY['likes','comments','shares','collections']) OR (SELECT count(*) FROM jsonb_object_keys(p->'metricDisplay'))<>4 THEN RETURN false; END IF;
    FOREACH m IN ARRAY ARRAY['likes','comments','shares','collections'] LOOP
      s:=p->'metricDisplay'->>m;
      IF p->'metricDisplay'->m='null'::jsonb THEN
        IF v->m<>'null'::jsonb THEN RETURN false; END IF;
      ELSE
        IF jsonb_typeof(p->'metricDisplay'->m)<>'string' OR length(s)>32 OR s<>btrim(s) THEN RETURN false; END IF;
        IF s ~ '^[0-9]+$' THEN
          IF jsonb_typeof(v->m)<>'number' OR s::numeric<>(v->>m)::numeric THEN RETURN false; END IF;
        ELSIF s ~ '^[0-9]+(\.[0-9]+)?(万|亿|[kKmMwW])\+?$' OR s ~ '^[0-9]+\+$' THEN
          IF v->m<>'null'::jsonb THEN RETURN false; END IF;
        ELSE RETURN false; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE OR REPLACE FUNCTION social_sync.valid_collection(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t jsonb;m jsonb;v jsonb;name text;last_id text;last_part text;part text;parts integer:=0;representative text;found_representative boolean:=false; BEGIN
  IF NOT social_sync.collection_exact_keys(p,ARRAY['version','source','target','title','observedAt','firstPublishedAt','membershipComplete','members','metrics','responseSha256','websitePublicationApproved']) OR
    p->'version' IS DISTINCT FROM '1'::jsonb OR (jsonb_typeof(p->'source') IS DISTINCT FROM 'string' OR p->>'source' NOT IN ('bilibili-collection-ssr','bilibili-collection-api-json')) OR
    p->'membershipComplete' IS DISTINCT FROM 'true'::jsonb OR p->'websitePublicationApproved' IS DISTINCT FROM 'false'::jsonb OR
    jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR length(btrim(p->>'title'))=0 OR length(p->>'title')>1000 OR
    jsonb_typeof(p->'observedAt') IS DISTINCT FROM 'string' OR NOT social_sync.valid_time(p->'observedAt') OR
    NOT social_sync.valid_time(p->'firstPublishedAt') OR
    (p->>'firstPublishedAt')::timestamptz>(p->>'observedAt')::timestamptz+interval '30 seconds' OR
    jsonb_typeof(p->'responseSha256') IS DISTINCT FROM 'string' OR p->>'responseSha256' !~ '^[a-f0-9]{64}$' OR octet_length(p::text)>524288 THEN RETURN false; END IF;
  t:=p->'target';
  IF NOT social_sync.collection_exact_keys(t,ARRAY['platform','kind','accountId','collectionId','representativeUrl']) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['platform','kind','accountId','collectionId','representativeUrl'] LOOP
    IF jsonb_typeof(t->name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF t->>'platform'<>'bilibili' OR t->>'kind' NOT IN ('season','multi-part') OR t->>'accountId' !~ '^[1-9][0-9]{0,19}$' OR
    t->>'representativeUrl' !~ '^https://www\.bilibili\.com/video/BV[0-9A-Za-z]{10}/$' THEN RETURN false; END IF;
  representative:=split_part(t->>'representativeUrl','/',5);
  IF (t->>'kind'='season' AND (t->>'collectionId' !~ '^[1-9][0-9]{0,19}$' OR p->'firstPublishedAt'<>'null'::jsonb)) OR
     (t->>'kind'='multi-part' AND t->>'collectionId'<>representative) THEN RETURN false; END IF;
  IF jsonb_typeof(p->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'members') NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
    IF NOT social_sync.collection_exact_keys(m,ARRAY['id','publishedAt','parts','partsComplete']) OR
      jsonb_typeof(m->'id') IS DISTINCT FROM 'string' OR m->>'id' !~ '^BV[0-9A-Za-z]{10}$' OR
      (last_id IS NOT NULL AND m->>'id'<=last_id COLLATE "C") OR NOT social_sync.valid_time(m->'publishedAt') OR
      (m->>'publishedAt')::timestamptz>(p->>'observedAt')::timestamptz+interval '30 seconds' OR
      jsonb_typeof(m->'partsComplete') IS DISTINCT FROM 'boolean' OR jsonb_typeof(m->'parts') IS DISTINCT FROM 'array' OR
      jsonb_array_length(m->'parts') NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
    last_id:=m->>'id';last_part:=NULL;parts:=parts+jsonb_array_length(m->'parts');
    IF last_id=representative THEN found_representative:=true; END IF;
    FOR v IN SELECT value FROM jsonb_array_elements(m->'parts') LOOP
      part:=v#>>'{}';
      IF jsonb_typeof(v)<>'string' OR part !~ '^[1-9][0-9]{0,19}$' OR (last_part IS NOT NULL AND part<=last_part COLLATE "C") THEN RETURN false; END IF;
      last_part:=part;
    END LOOP;
  END LOOP;
  IF parts>2000 OR NOT found_representative OR (t->>'kind'='multi-part' AND
    (jsonb_array_length(p->'members')<>1 OR p->'members'->0->'partsComplete'<>'true'::jsonb OR
     jsonb_array_length(p->'members'->0->'parts')<2 OR p->'members'->0->'publishedAt'<>p->'firstPublishedAt')) THEN RETURN false; END IF;
  m:=p->'metrics';
  IF NOT social_sync.collection_exact_keys(m,ARRAY['views','likes','comments','shares','collections','coins','danmaku']) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['views','likes','comments','shares','collections','coins','danmaku'] LOOP
    IF NOT social_sync.valid_count(m->name) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

UPDATE social_sync.meta SET bilibili_api_version=1 WHERE singleton AND version=1;
UPDATE social_sync.collection_meta SET bilibili_api_version=1 WHERE singleton AND version=1;
COMMIT;
