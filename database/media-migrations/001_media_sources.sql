-- Additive private image locator index; frozen content/reader migrations stay unchanged.
BEGIN;
CREATE SCHEMA nb_media;
CREATE SCHEMA nb_media_api;
REVOKE ALL ON SCHEMA nb_media,nb_media_api FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_media REVOKE ALL ON TABLES FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_media_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,nb_reader,nb_writer;

CREATE TABLE nb_media.migrations (
  version text PRIMARY KEY,
  digest text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO nb_media.migrations(version) VALUES('001-media-sources');
CREATE TABLE nb_media.sources (
  run_id uuid NOT NULL,
  asset_id text NOT NULL,
  binding jsonb NOT NULL,
  PRIMARY KEY(run_id,asset_id),
  FOREIGN KEY(run_id,asset_id) REFERENCES nb.media(run_id,asset_id) ON DELETE CASCADE
);
ALTER TABLE nb_media.migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_media.sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_media FROM PUBLIC,nb_reader,nb_writer;

CREATE FUNCTION nb_media_api.stage_sources(p_run uuid,p_fence bigint,p_bindings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_media,nb,pg_temp AS $$
DECLARE x jsonb; descriptor jsonb; location jsonb; locator_key text; expected_asset text;
BEGIN
  -- The same fence/revision/epoch/TTL check and state lock as the frozen worker.
  PERFORM nb.assert_lease(p_run,p_fence);
  IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'NB_MEDIA_SOURCE_BATCH_INVALID'; END IF;
  IF jsonb_array_length(p_bindings)>100 OR octet_length(p_bindings::text)>262144 THEN
    RAISE EXCEPTION 'NB_MEDIA_SOURCE_BATCH_INVALID'; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(p_bindings) v GROUP BY v->>'assetId' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'NB_MEDIA_SOURCE_BATCH_INVALID'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_bindings) LOOP
    IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR
      NOT x ?& ARRAY['assetId','ownerPageId','sha256','locator','delivery','sourceFingerprint'] OR
      x-ARRAY['assetId','ownerPageId','sha256','locator','delivery','sourceFingerprint']<>'{}'::jsonb OR
      jsonb_typeof(x->'assetId') IS DISTINCT FROM 'string' OR x->>'assetId' !~ '^a1\.[a-f0-9]{64}$' OR
      jsonb_typeof(x->'ownerPageId') IS DISTINCT FROM 'string' OR length(x->>'ownerPageId') NOT BETWEEN 1 AND 128 OR
      jsonb_typeof(x->'sha256') IS DISTINCT FROM 'string' OR x->>'sha256' !~ '^[a-f0-9]{64}$' OR
      jsonb_typeof(x->'sourceFingerprint') IS DISTINCT FROM 'string' OR x->>'sourceFingerprint' !~ '^[a-f0-9]{64}$' OR
      jsonb_typeof(x->'delivery') IS DISTINCT FROM 'string' OR x->>'delivery' NOT IN ('notion','storage') THEN
      RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
    location:=x->'locator';
    IF jsonb_typeof(location) IS DISTINCT FROM 'object' OR jsonb_typeof(location->'kind') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
    CASE location->>'kind'
      WHEN 'cover' THEN
        IF location<>jsonb_build_object('kind','cover') THEN RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
        locator_key:='cover';
      WHEN 'block' THEN
        IF jsonb_typeof(location->'id') IS DISTINCT FROM 'string' OR location->>'id' !~ '^[a-f0-9]{32}$' OR
          location<>jsonb_build_object('kind','block','id',location->>'id') THEN
          RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
        locator_key:='block:'||(location->>'id');
      WHEN 'property' THEN
        IF jsonb_typeof(location->'name') IS DISTINCT FROM 'string' OR length(location->>'name') NOT BETWEEN 1 AND 256 OR
          location<>jsonb_build_object('kind','property','name',location->>'name') THEN
          RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
        locator_key:='property:'||(location->>'name');
      ELSE RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID';
    END CASE;
    -- Reproduce v1's canonical JSON array without jsonb's delimiter whitespace.
    expected_asset:='a1.'||encode(sha256(convert_to('['||to_json(x->>'ownerPageId')::text||','||
      to_json(locator_key)::text||','||to_json(x->>'sha256')::text||']','UTF8')),'hex');
    IF expected_asset IS DISTINCT FROM x->>'assetId' THEN RAISE EXCEPTION 'NB_MEDIA_SOURCE_INVALID'; END IF;
    SELECT m.descriptor INTO descriptor FROM nb.media m
      WHERE m.run_id=p_run AND m.asset_id=x->>'assetId' AND m.owner_page_id=x->>'ownerPageId';
    IF descriptor IS NULL OR descriptor->>'assetId' IS DISTINCT FROM x->>'assetId' OR
      descriptor->>'ownerPageId' IS DISTINCT FROM x->>'ownerPageId' OR descriptor->>'sha256' IS DISTINCT FROM x->>'sha256' THEN
      RAISE EXCEPTION 'NB_MEDIA_SOURCE_OWNER_INVALID'; END IF;
    INSERT INTO nb_media.sources VALUES(p_run,x->>'assetId',x)
      ON CONFLICT(run_id,asset_id) DO UPDATE SET binding=EXCLUDED.binding;
  END LOOP;
END $$;

CREATE FUNCTION nb_media_api.read_source(p_asset text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_media,nb,pg_temp AS $$
DECLARE projection jsonb; snapshot nb.runs; source jsonb;
BEGIN
  -- Both core eligibility and the generation-bound locator use one statement snapshot.
  projection:=nb_api.read_media(p_asset);
  snapshot:=nb.current_snapshot();
  SELECT s.binding INTO source FROM nb_media.sources s
    WHERE s.run_id=snapshot.id AND s.asset_id=p_asset AND
      s.binding->>'assetId'=projection->'media'->>'assetId' AND
      s.binding->>'ownerPageId'=projection->'media'->>'ownerPageId' AND
      s.binding->>'sha256'=projection->'media'->>'sha256';
  RETURN jsonb_build_object('schemaDigest',projection->>'schemaDigest',
    'mediaCapability','notionblog-media-source-v1',
    'media',CASE WHEN source IS NULL THEN NULL ELSE projection->'media' END,'binding',source);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_media_api FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nb_media,nb_media_api FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_media FROM %I',role_name);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_media_api FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA nb_media REVOKE ALL ON TABLES FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA nb_media_api REVOKE EXECUTE ON FUNCTIONS FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA nb_media_api TO nb_reader,nb_writer;
GRANT EXECUTE ON FUNCTION nb_media_api.stage_sources(uuid,bigint,jsonb) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_media_api.read_source(text) TO nb_reader;
COMMIT;
