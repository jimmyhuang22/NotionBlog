-- Independent, regenerable derivatives; content publication and freshness stay unchanged.
BEGIN;
CREATE SCHEMA nb_thumbnails;
CREATE SCHEMA nb_thumbnail_api;
REVOKE ALL ON SCHEMA nb_thumbnails,nb_thumbnail_api FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnails REVOKE ALL ON TABLES FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnails REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnail_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,nb_reader,nb_writer;

CREATE TABLE nb_thumbnails.migrations (
  version text PRIMARY KEY,
  digest text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO nb_thumbnails.migrations(version) VALUES('001-media-thumbnails');
CREATE TABLE nb_thumbnails.media (
  version text NOT NULL CHECK(version IN ('v1','v2')),
  run_id uuid NOT NULL,
  parent_asset_id text NOT NULL CHECK(parent_asset_id ~ '^a1\.[a-f0-9]{64}$'),
  parent_sha text NOT NULL CHECK(parent_sha ~ '^[a-f0-9]{64}$'),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
  width_cap integer NOT NULL CHECK(width_cap IN (400,800)),
  descriptor jsonb NOT NULL,
  PRIMARY KEY(version,run_id,parent_asset_id,width_cap)
);
ALTER TABLE nb_thumbnails.migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_thumbnails.media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_thumbnails FROM PUBLIC,nb_reader,nb_writer;

-- Static whitelisted branches work on either v1-only or v2-only installations.
-- Each branch reads its generation and source eligibility in one SQL snapshot.
CREATE FUNCTION nb_thumbnails.qualified_source(p_version text,p_asset text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_thumbnails,pg_temp AS $$
DECLARE generation text; projection jsonb; expected_digest text; expected_capability text;
BEGIN
  IF p_asset IS NULL OR p_asset !~ '^a1\.[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NB_THUMBNAIL_QUERY_INVALID'; END IF;
  IF p_version='v1' THEN
    IF to_regprocedure('nb_media_api.read_source(text)') IS NULL THEN RAISE EXCEPTION 'NB_THUMBNAIL_UNAVAILABLE'; END IF;
    EXECUTE 'SELECT s.id::text,nb_media_api.read_source($1) FROM nb.current_snapshot() AS s' INTO generation,projection USING p_asset;
    expected_digest:='74880b7667ebc1fd2fd476a84bb5fabf55bd6833eb8b9da11c8df696c5c99b6a';
    expected_capability:='notionblog-media-source-v1';
  ELSIF p_version='v2' THEN
    IF to_regprocedure('nb_v2_media_api.read_source(text)') IS NULL THEN RAISE EXCEPTION 'NB_THUMBNAIL_UNAVAILABLE'; END IF;
    EXECUTE 'SELECT s.id::text,nb_v2_media_api.read_source($1) FROM nb_v2.current_snapshot() AS s' INTO generation,projection USING p_asset;
    expected_digest:='6cc1930413741a7263cac15f5011ede34c7e7e61188435320af2c1d4ad9e4936';
    expected_capability:='notionblog-website-media-source-v1';
  ELSE RAISE EXCEPTION 'NB_THUMBNAIL_QUERY_INVALID';
  END IF;
  IF generation IS NULL OR projection->>'schemaDigest' IS DISTINCT FROM expected_digest OR
    projection->>'mediaCapability' IS DISTINCT FROM expected_capability THEN RAISE EXCEPTION 'NB_THUMBNAIL_UNAVAILABLE'; END IF;
  IF projection->'media' IS NULL OR projection->'media'='null'::jsonb OR
    projection->'binding' IS NULL OR projection->'binding'='null'::jsonb THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('thumbnailCapability','notionblog-thumbnail-index-v1','schemaDigest',expected_digest,
    'version',p_version,'runId',generation,'source',jsonb_build_object('media',projection->'media','binding',projection->'binding'));
END $$;

CREATE FUNCTION nb_thumbnail_api.read_media(p_version text,p_asset text,p_width integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_thumbnails,pg_temp AS $$
DECLARE projection jsonb; thumbnail jsonb;
BEGIN
  IF p_width IS NULL OR p_width NOT IN (400,800) THEN RAISE EXCEPTION 'NB_THUMBNAIL_QUERY_INVALID'; END IF;
  projection:=nb_thumbnails.qualified_source(p_version,p_asset);
  IF projection IS NULL THEN RETURN NULL; END IF;
  SELECT t.descriptor INTO thumbnail FROM nb_thumbnails.media t
    WHERE t.version=p_version AND t.run_id=(projection->>'runId')::uuid AND t.parent_asset_id=p_asset AND t.width_cap=p_width AND
      t.parent_sha=projection->'source'->'media'->>'sha256' AND
      t.source_fingerprint=projection->'source'->'binding'->>'sourceFingerprint' AND
      t.descriptor->>'ownerPageId'=projection->'source'->'media'->>'ownerPageId';
  RETURN projection||jsonb_build_object('thumbnail',thumbnail);
END $$;

CREATE FUNCTION nb_thumbnail_api.register_media(p_version text,p_run uuid,p_parent text,p_sha text,p_fingerprint text,p_width integer,p_descriptor jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_thumbnails,pg_temp AS $$
DECLARE projection jsonb; expected_asset text; existing nb_thumbnails.media;
BEGIN
  IF p_run IS NULL OR p_width IS NULL OR p_width NOT IN (400,800) OR
    p_sha IS NULL OR p_sha !~ '^[a-f0-9]{64}$' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'NB_THUMBNAIL_INVALID'; END IF;
  projection:=nb_thumbnails.qualified_source(p_version,p_parent);
  IF projection IS NULL OR (projection->>'runId')::uuid IS DISTINCT FROM p_run OR
    projection->'source'->'media'->>'sha256' IS DISTINCT FROM p_sha OR
    projection->'source'->'binding'->>'sourceFingerprint' IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'NB_THUMBNAIL_SOURCE_INVALID'; END IF;
  IF jsonb_typeof(p_descriptor) IS DISTINCT FROM 'object' OR
    NOT p_descriptor ?& ARRAY['assetId','ownerPageId','objectKey','sha256','byteSize','mime','width','height'] OR
    p_descriptor-ARRAY['assetId','ownerPageId','objectKey','sha256','byteSize','mime','width','height']<>'{}'::jsonb OR
    jsonb_typeof(p_descriptor->'assetId') IS DISTINCT FROM 'string' OR p_descriptor->>'assetId' !~ '^a1\.[a-f0-9]{64}$' OR
    jsonb_typeof(p_descriptor->'ownerPageId') IS DISTINCT FROM 'string' OR
    p_descriptor->>'ownerPageId' IS DISTINCT FROM projection->'source'->'media'->>'ownerPageId' OR
    jsonb_typeof(p_descriptor->'sha256') IS DISTINCT FROM 'string' OR p_descriptor->>'sha256' !~ '^[a-f0-9]{64}$' OR
    jsonb_typeof(p_descriptor->'objectKey') IS DISTINCT FROM 'string' OR
    p_descriptor->>'objectKey' IS DISTINCT FROM 'sha256/'||(p_descriptor->>'sha256') OR
    jsonb_typeof(p_descriptor->'mime') IS DISTINCT FROM 'string' OR p_descriptor->>'mime'<>'image/webp' OR
    jsonb_typeof(p_descriptor->'byteSize') IS DISTINCT FROM 'number' OR
    jsonb_typeof(p_descriptor->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(p_descriptor->'height') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'NB_THUMBNAIL_INVALID'; END IF;
  IF (p_descriptor->>'byteSize')::numeric NOT BETWEEN 1 AND 20971520 OR
    (p_descriptor->>'byteSize')::numeric<>trunc((p_descriptor->>'byteSize')::numeric) OR
    (p_descriptor->>'width')::numeric NOT BETWEEN 1 AND p_width OR
    (p_descriptor->>'width')::numeric<>trunc((p_descriptor->>'width')::numeric) OR
    (p_descriptor->>'height')::numeric NOT BETWEEN 1 AND 16383 OR
    (p_descriptor->>'height')::numeric<>trunc((p_descriptor->>'height')::numeric) THEN RAISE EXCEPTION 'NB_THUMBNAIL_INVALID'; END IF;
  expected_asset:='a1.'||encode(sha256(convert_to('['||to_json(p_descriptor->>'ownerPageId')::text||','||
    to_json('thumbnail:'||p_width::text||':'||p_parent)::text||','||to_json(p_descriptor->>'sha256')::text||']','UTF8')),'hex');
  IF p_descriptor->>'assetId' IS DISTINCT FROM expected_asset THEN RAISE EXCEPTION 'NB_THUMBNAIL_INVALID'; END IF;
  INSERT INTO nb_thumbnails.media VALUES(p_version,p_run,p_parent,p_sha,p_fingerprint,p_width,p_descriptor)
    ON CONFLICT(version,run_id,parent_asset_id,width_cap) DO NOTHING;
  SELECT * INTO existing FROM nb_thumbnails.media
    WHERE version=p_version AND run_id=p_run AND parent_asset_id=p_parent AND width_cap=p_width;
  IF existing.parent_sha IS DISTINCT FROM p_sha OR existing.source_fingerprint IS DISTINCT FROM p_fingerprint OR
    existing.descriptor IS DISTINCT FROM p_descriptor THEN RAISE EXCEPTION 'NB_THUMBNAIL_IMMUTABLE'; END IF;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_thumbnails,nb_thumbnail_api FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nb_thumbnails,nb_thumbnail_api FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_thumbnails FROM %I',role_name);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_thumbnails,nb_thumbnail_api FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnails REVOKE ALL ON TABLES FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnails REVOKE EXECUTE ON FUNCTIONS FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA nb_thumbnail_api REVOKE EXECUTE ON FUNCTIONS FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA nb_thumbnail_api TO nb_reader,nb_writer;
GRANT EXECUTE ON FUNCTION nb_thumbnail_api.read_media(text,text,integer) TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) TO nb_writer;
COMMIT;
