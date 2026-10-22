-- Optional v2 course-cover cap; existing expiry wrapper and v1 stay unchanged.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('nb_thumbnail_api.read_media(text,text,integer)') AND md5(prosrc)='8ad4ee37d6a4bb7bde75f4e66613ad9b' AND prosecdef) OR
     NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('nb_availability.register_qualified_legacy(text,uuid,text,text,text,integer,jsonb)') AND md5(prosrc)='caf3ba417e0357920cdfa8c8c4091be2' AND prosecdef) OR
     NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb)') AND md5(prosrc)='92bfdd6f063c4d442eb65f6f95bd4171' AND prosecdef) THEN
    RAISE EXCEPTION 'NB_COURSE_THUMBNAIL_BASE_MISMATCH';
  END IF;
END $$;
CREATE TABLE nb_thumbnails.extensions (
  version text PRIMARY KEY,
  digest text NOT NULL
);
ALTER TABLE nb_thumbnails.extensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_thumbnails.extensions FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON nb_thumbnails.extensions FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
INSERT INTO nb_thumbnails.extensions VALUES ('001-course-cover-1600','unverified');
ALTER TABLE nb_thumbnails.media DROP CONSTRAINT media_width_cap_check;
ALTER TABLE nb_thumbnails.media ADD CONSTRAINT media_width_cap_check CHECK
  (width_cap IN (400,800) OR (version='v2' AND width_cap=1600));

CREATE OR REPLACE FUNCTION nb_thumbnail_api.read_media(p_version text,p_asset text,p_width integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_thumbnails,pg_temp AS $$
DECLARE projection jsonb; thumbnail jsonb;
BEGIN
  IF p_width IS NULL OR p_width NOT IN (400,800,1600) OR (p_width=1600 AND p_version IS DISTINCT FROM 'v2') THEN RAISE EXCEPTION 'NB_THUMBNAIL_QUERY_INVALID'; END IF;
  projection:=nb_thumbnails.qualified_source(p_version,p_asset);
  IF projection IS NULL THEN RETURN NULL; END IF;
  IF p_width=1600 AND NOT EXISTS (
    SELECT FROM nb_v2.records r WHERE r.run_id=(projection->>'runId')::uuid AND
      r.id=projection->'source'->'media'->>'ownerPageId' AND r.kind='course' AND
      r.item->'cover'->>'id'=p_asset AND projection->'source'->'binding'->'locator'->>'kind'='cover'
  ) THEN RETURN NULL; END IF;
  SELECT t.descriptor INTO thumbnail FROM nb_thumbnails.media t
    WHERE t.version=p_version AND t.run_id=(projection->>'runId')::uuid AND t.parent_asset_id=p_asset AND t.width_cap=p_width AND
      t.parent_sha=projection->'source'->'media'->>'sha256' AND
      t.source_fingerprint=projection->'source'->'binding'->>'sourceFingerprint' AND
      t.descriptor->>'ownerPageId'=projection->'source'->'media'->>'ownerPageId';
  RETURN projection||jsonb_build_object('thumbnail',thumbnail);
END $$;

CREATE OR REPLACE FUNCTION nb_availability.register_qualified_legacy(p_version text,p_run uuid,p_parent text,p_sha text,p_fingerprint text,p_width integer,p_descriptor jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_thumbnails,pg_temp AS $$
DECLARE projection jsonb; expected_asset text; existing nb_thumbnails.media;
BEGIN
  IF p_run IS NULL OR p_width IS NULL OR p_width NOT IN (400,800,1600) OR (p_width=1600 AND p_version IS DISTINCT FROM 'v2') OR
    p_sha IS NULL OR p_sha !~ '^[a-f0-9]{64}$' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'NB_THUMBNAIL_INVALID'; END IF;
  projection:=nb_thumbnails.qualified_source(p_version,p_parent);
  IF projection IS NULL OR (projection->>'runId')::uuid IS DISTINCT FROM p_run OR
    projection->'source'->'media'->>'sha256' IS DISTINCT FROM p_sha OR
    projection->'source'->'binding'->>'sourceFingerprint' IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'NB_THUMBNAIL_SOURCE_INVALID'; END IF;
  IF p_width=1600 AND (
    COALESCE((projection->'source'->'media'->>'width')::numeric,0)<1600 OR
    (p_descriptor->>'width') IS DISTINCT FROM '1600' OR
    COALESCE((projection->'source'->'media'->>'height')::numeric,0)<(p_descriptor->>'height')::numeric OR
    NOT EXISTS (SELECT FROM nb_v2.records r WHERE r.run_id=p_run AND
      r.id=projection->'source'->'media'->>'ownerPageId' AND r.kind='course' AND
      r.item->'cover'->>'id'=p_parent AND projection->'source'->'binding'->'locator'->>'kind'='cover')
  ) THEN RAISE EXCEPTION 'NB_COURSE_THUMBNAIL_SOURCE_INVALID'; END IF;
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

-- CREATE OR REPLACE preserves ACLs; the legacy writer remains callable only by
-- its existing expiry-checking wrapper, not by the reader or writer roles.
REVOKE ALL ON FUNCTION nb_availability.register_qualified_legacy(text,uuid,text,text,text,integer,jsonb) FROM PUBLIC,nb_reader,nb_writer;
COMMIT;
