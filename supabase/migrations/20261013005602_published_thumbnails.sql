-- Independent thumbnail delivery. Existing qualified APIs and registry stay unchanged.
BEGIN;
CREATE INDEX published_parent_idx ON nb_thumbnails.media(version,parent_asset_id,parent_sha,width_cap,run_id);

CREATE FUNCTION nb_publication_api.check_thumbnail_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_digest ~ '^[a-f0-9]{64}$' AND
   obj_description(to_regprocedure('nb_publication_api.read_thumbnail(text,integer,text)'),'pg_proc')=p_digest AND
   to_regclass('nb_thumbnails.published_parent_idx') IS NOT NULL AND
   to_regprocedure('nb_publication_api.register_thumbnail(text,text,text,integer,jsonb,text)') IS NOT NULL AND
   nb_publication_api.check_capability('6b1b7e2ab295284814330536bb7095972831d3356e63c6b542d1d7b92d9b79bf') AND
   (SELECT count(*)=1 AND bool_and(version='001-media-thumbnails' AND
     digest='671e034b85f1c859c9a2fcbf4ea915c8dba371412472d83da2566c3f1e0ec3fa') FROM nb_thumbnails.migrations)
$$;

CREATE FUNCTION nb_publication_api.read_thumbnail(p_asset text,p_width integer,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; s nb_v2.state; original jsonb; thumbnail jsonb;
BEGIN
 IF p_asset IS NULL OR p_asset !~ '^a1\.[a-f0-9]{64}$' OR p_width IS NULL OR p_width NOT IN (400,800) THEN
   RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_QUERY_INVALID'; END IF;
 IF nb_publication_api.check_thumbnail_capability(p_digest) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_UNAVAILABLE'; END IF;
 r:=nb_publication.current_snapshot(); SELECT * INTO s FROM nb_v2.state WHERE singleton;
 IF s.schema_digest IS DISTINCT FROM '6cc1930413741a7263cac15f5011ede34c7e7e61188435320af2c1d4ad9e4936' THEN
   RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_UNAVAILABLE'; END IF;
 SELECT m.descriptor INTO original FROM nb_v2.media m
   WHERE m.run_id=r.id AND m.asset_id=p_asset AND nb_v2.record_eligible(r.id,m.owner_page_id);
 IF original IS NULL THEN RETURN NULL; END IF;
 -- Historical bytes are reusable only for the same current content-addressed
 -- parent. No live source locator or qualified validity window is consulted.
 SELECT t.descriptor INTO thumbnail FROM nb_thumbnails.media t
   JOIN nb_v2.media m ON m.run_id=t.run_id AND m.asset_id=t.parent_asset_id
   JOIN nb_v2.runs seed ON seed.id=t.run_id AND seed.status='published'
   WHERE t.version='v2' AND t.parent_asset_id=p_asset AND t.parent_sha=original->>'sha256' AND t.width_cap=p_width AND
     m.descriptor->>'sha256'=original->>'sha256' AND m.owner_page_id=original->>'ownerPageId'
   ORDER BY seed.finished_at DESC,t.run_id DESC LIMIT 1;
 RETURN jsonb_build_object('thumbnailCapability','notionblog-published-thumbnails-v1','migrationDigest',p_digest,
   'schemaDigest',s.schema_digest,'publicationRevision',r.id::text||':'||s.revision::text,
   'configDigest',s.config_digest,'policyEpoch',s.epoch::text,'widthCap',p_width,'original',original,'thumbnail',thumbnail);
END $$;

-- Background registration has no source locator and cannot publish content or
-- renew qualification. The parent must already be in the accepted publication.
CREATE FUNCTION nb_publication_api.register_thumbnail(p_revision text,p_asset text,p_sha text,p_width integer,p_descriptor jsonb,p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; s nb_v2.state; original jsonb; old nb_thumbnails.media; expected_asset text;
BEGIN
 IF nb_publication_api.check_thumbnail_capability(p_digest) IS DISTINCT FROM true THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_UNAVAILABLE'; END IF;
 SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE;
 PERFORM 1 FROM nb_publication.state WHERE singleton FOR UPDATE;
 r:=nb_publication.current_snapshot();
 IF p_revision IS DISTINCT FROM r.id::text||':'||s.revision::text THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_VERSION_CHANGED'; END IF;
 IF p_asset IS NULL OR p_asset !~ '^a1\.[a-f0-9]{64}$' OR p_sha IS NULL OR p_sha !~ '^[a-f0-9]{64}$' OR
   p_width IS NULL OR p_width NOT IN (400,800) THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_INVALID'; END IF;
 SELECT descriptor INTO original FROM nb_v2.media WHERE run_id=r.id AND asset_id=p_asset AND nb_v2.record_eligible(r.id,owner_page_id);
 IF original IS NULL OR original->>'sha256' IS DISTINCT FROM p_sha THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_PARENT_INVALID'; END IF;
 IF jsonb_typeof(p_descriptor) IS DISTINCT FROM 'object' OR
   NOT p_descriptor ?& ARRAY['assetId','ownerPageId','objectKey','sha256','byteSize','mime','width','height'] OR
   p_descriptor-ARRAY['assetId','ownerPageId','objectKey','sha256','byteSize','mime','width','height']<>'{}'::jsonb OR
   jsonb_typeof(p_descriptor->'assetId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_descriptor->'ownerPageId') IS DISTINCT FROM 'string' OR
   jsonb_typeof(p_descriptor->'objectKey') IS DISTINCT FROM 'string' OR jsonb_typeof(p_descriptor->'mime') IS DISTINCT FROM 'string' OR
   p_descriptor->>'ownerPageId' IS DISTINCT FROM original->>'ownerPageId' OR
   jsonb_typeof(p_descriptor->'sha256') IS DISTINCT FROM 'string' OR p_descriptor->>'sha256' !~ '^[a-f0-9]{64}$' OR
   p_descriptor->>'objectKey' IS DISTINCT FROM 'sha256/'||(p_descriptor->>'sha256') OR p_descriptor->>'mime' IS DISTINCT FROM 'image/webp' OR
   jsonb_typeof(p_descriptor->'byteSize') IS DISTINCT FROM 'number' OR jsonb_typeof(p_descriptor->'width') IS DISTINCT FROM 'number' OR
   jsonb_typeof(p_descriptor->'height') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_INVALID'; END IF;
 IF (p_descriptor->>'byteSize')::numeric NOT BETWEEN 1 AND 20971520 OR
   (p_descriptor->>'byteSize')::numeric<>trunc((p_descriptor->>'byteSize')::numeric) OR
   (p_descriptor->>'byteSize')::numeric>=(original->>'byteSize')::numeric OR
   (p_descriptor->>'width')::numeric NOT BETWEEN 1 AND p_width OR (p_descriptor->>'height')::numeric NOT BETWEEN 1 AND 16383 OR
   (p_descriptor->>'width')::numeric<>trunc((p_descriptor->>'width')::numeric) OR (p_descriptor->>'height')::numeric<>trunc((p_descriptor->>'height')::numeric) OR
   (original->>'width' IS NOT NULL AND (p_descriptor->>'width')::numeric>(original->>'width')::numeric) OR
   (original->>'height' IS NOT NULL AND (p_descriptor->>'height')::numeric>(original->>'height')::numeric) THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_INVALID'; END IF;
 expected_asset:='a1.'||encode(sha256(convert_to('['||to_json(original->>'ownerPageId')::text||','||
   to_json('thumbnail:'||p_width::text||':'||p_asset)::text||','||to_json(p_descriptor->>'sha256')::text||']','UTF8')),'hex');
 IF p_descriptor->>'assetId' IS DISTINCT FROM expected_asset THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_INVALID'; END IF;
 INSERT INTO nb_thumbnails.media VALUES('v2',r.id,p_asset,p_sha,encode(sha256(convert_to('published:'||p_asset||':'||p_sha,'UTF8')),'hex'),p_width,p_descriptor)
   ON CONFLICT(version,run_id,parent_asset_id,width_cap) DO NOTHING;
 SELECT * INTO old FROM nb_thumbnails.media WHERE version='v2' AND run_id=r.id AND parent_asset_id=p_asset AND width_cap=p_width;
 IF old.parent_sha IS DISTINCT FROM p_sha OR old.descriptor IS DISTINCT FROM p_descriptor THEN RAISE EXCEPTION 'NB_PUBLISHED_THUMBNAIL_IMMUTABLE'; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION nb_publication_api.check_thumbnail_capability(text),
 nb_publication_api.read_thumbnail(text,integer,text),nb_publication_api.register_thumbnail(text,text,text,integer,jsonb,text) FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_publication_api.check_thumbnail_capability(text),nb_publication_api.read_thumbnail(text,integer,text),nb_publication_api.register_thumbnail(text,text,text,integer,jsonb,text) FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_publication_api.check_thumbnail_capability(text),
 nb_publication_api.read_thumbnail(text,integer,text) TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_publication_api.register_thumbnail(text,text,text,integer,jsonb,text) TO nb_writer;
COMMIT;
