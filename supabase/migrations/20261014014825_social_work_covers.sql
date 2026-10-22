-- Optional independent social media domain. No content/thumbnail protocol is altered.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM social_sync.retained_meta WHERE singleton AND version=1) THEN
  RAISE EXCEPTION 'NB_SOCIAL_COVER_PROTOCOL';
 END IF;
END $$;
CREATE ROLE nb_social_media_worker NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
GRANT nb_social_reader TO nb_social_media_worker;
CREATE TABLE social_sync.cover_meta(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1));
INSERT INTO social_sync.cover_meta VALUES(true,1);
CREATE TABLE social_sync.cover_sources(
 display_mode text NOT NULL CHECK(display_mode IN ('trial','retained')),
 owner_kind text NOT NULL CHECK(owner_kind IN ('publication','collection')),
 owner_key text NOT NULL CHECK(owner_key ~ '^[a-f0-9]{64}$'),
 source_sha256 text CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 publication_kind text CHECK((owner_kind='publication' AND publication_kind IS NOT NULL AND publication_kind IN ('video','image-note')) OR (owner_kind='collection' AND publication_kind IS NULL)),
 observed_at text NOT NULL CHECK(social_sync.valid_time(to_jsonb(observed_at))),
 PRIMARY KEY(display_mode,owner_kind,owner_key)
);
CREATE FUNCTION social_sync.cover_owner_visible(mode text,kind text,key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE
  WHEN mode='trial' AND kind='publication' THEN EXISTS(SELECT 1 FROM social_sync.website_visibility v JOIN social_sync.publications p USING(publication_key) WHERE v.publication_key=key)
  WHEN mode='retained' AND kind='publication' THEN EXISTS(SELECT 1 FROM social_sync.retained_publications p JOIN social_sync.works w USING(work_id) WHERE p.publication_key=key AND p.approved AND w.approved)
  WHEN mode='trial' AND kind='collection' THEN EXISTS(SELECT 1 FROM social_sync.website_collections c WHERE c.collection_key=key)
  WHEN mode='retained' AND kind='collection' THEN EXISTS(SELECT 1 FROM social_sync.retained_website_collections c WHERE c.collection_key=key)
  ELSE false END
$$;
CREATE FUNCTION social_sync.cover_collection_time(mode text,key text,at text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN mode='trial' THEN EXISTS(SELECT 1 FROM social_sync.website_collections c WHERE c.collection_key=key AND c.collection->>'observedAt'=at)
  WHEN mode='retained' THEN EXISTS(SELECT 1 FROM social_sync.retained_website_collections c WHERE c.collection_key=key AND c.collection->>'observedAt'=at)
  ELSE false END
$$;
CREATE FUNCTION social_sync.valid_cover_media(p jsonb,kind text,key text,cap integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT social_sync.collection_exact_keys(p,ARRAY['assetId','ownerPageId','objectKey','sha256','byteSize','mime','width','height']) THEN RETURN false; END IF;
 RETURN jsonb_typeof(p->'assetId')='string' AND p->>'assetId' ~ '^a1\.[a-f0-9]{64}$' AND
  p->>'ownerPageId'='social_'||kind||'_'||key AND p->>'sha256' ~ '^[a-f0-9]{64}$' AND p->>'objectKey'='sha256/'||(p->>'sha256') AND
  jsonb_typeof(p->'byteSize')='number' AND p->>'byteSize' ~ '^[1-9][0-9]*$' AND (p->>'byteSize')::bigint<=20971520 AND
  p->>'mime' IN ('image/jpeg','image/png','image/webp','image/gif','image/avif') AND
  jsonb_typeof(p->'width')='number' AND jsonb_typeof(p->'height')='number' AND
  p->>'width' ~ '^[1-9][0-9]*$' AND p->>'height' ~ '^[1-9][0-9]*$' AND
  (p->>'width')::bigint*(p->>'height')::bigint<=40000000 AND (cap IS NULL OR (p->>'width')::bigint<=cap);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION social_sync.valid_cover_files(p jsonb,kind text,key text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT social_sync.collection_exact_keys(p,ARRAY['original','previews']) AND
  social_sync.collection_exact_keys(p->'previews',ARRAY['400','800']) AND
  social_sync.valid_cover_media(p->'original',kind,key,NULL) AND
  social_sync.valid_cover_media(p->'previews'->'400',kind,key,400) AND social_sync.valid_cover_media(p->'previews'->'800',kind,key,800)
$$;
CREATE FUNCTION social_sync.cover_asset_id(kind text,key text,source text,original text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT 's1.'||encode(sha256(convert_to('["'||kind||'","'||key||'","'||source||'","'||original||'"]','UTF8')),'hex')
$$;
CREATE TABLE social_sync.cover_bindings(
 display_mode text NOT NULL CHECK(display_mode IN ('trial','retained')),
 owner_kind text NOT NULL,owner_key text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 files jsonb NOT NULL CHECK(social_sync.valid_cover_files(files,owner_kind,owner_key) IS TRUE),
 asset_id text GENERATED ALWAYS AS (social_sync.cover_asset_id(owner_kind,owner_key,source_sha256,files->'original'->>'sha256')) STORED,
 PRIMARY KEY(display_mode,owner_kind,owner_key), UNIQUE(display_mode,asset_id),
 FOREIGN KEY(display_mode,owner_kind,owner_key) REFERENCES social_sync.cover_sources(display_mode,owner_kind,owner_key) ON DELETE CASCADE
);
CREATE FUNCTION social_sync.cover_source_matches(mode text,kind text,key text,source text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM social_sync.cover_sources s WHERE s.display_mode=mode AND s.owner_kind=kind AND s.owner_key=key AND s.source_sha256 IS NOT DISTINCT FROM source
  AND CASE WHEN kind='collection' THEN social_sync.cover_collection_time(mode,key,s.observed_at)
   WHEN mode='trial' THEN EXISTS(SELECT 1 FROM social_sync.website_publications p WHERE p.publication->>'id'=key AND p.publication->>'kind'=s.publication_kind)
   WHEN mode='retained' THEN EXISTS(SELECT 1 FROM social_sync.retained_website_publications p WHERE p.publication->>'id'=key AND p.publication->>'kind'=s.publication_kind)
   ELSE false END)
$$;

-- Synchronize ONLY a URL digest. The raw private observation never becomes a website-readable cover URL.
-- Dedicated direct SQL ingestion, not Auth/JWT: trigger-only execution, strict actor/trigger gate, no RPC grant.
CREATE FUNCTION social_sync.sync_cover_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user NOT IN ('nb_social_worker','postgres','supabase_admin') OR TG_TABLE_SCHEMA<>'social_sync' OR
  TG_TABLE_NAME<>'publications' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' THEN RAISE EXCEPTION 'NB_SOCIAL_COVER_ACTOR'; END IF;
 IF TG_OP='DELETE' THEN DELETE FROM social_sync.cover_sources WHERE owner_kind='publication' AND owner_key=OLD.publication_key;
 ELSE
  INSERT INTO social_sync.cover_sources(display_mode,owner_kind,owner_key,source_sha256,observed_at,publication_kind)
  SELECT mode,'publication',NEW.publication_key,CASE WHEN NEW.payload->>'coverUrl' IS NULL THEN NULL ELSE
   encode(sha256(convert_to(NEW.payload->>'coverUrl','UTF8')),'hex') END,NEW.observed_at,NEW.payload->>'kind' FROM (VALUES('trial'),('retained')) modes(mode)
  ON CONFLICT(display_mode,owner_kind,owner_key) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,observed_at=EXCLUDED.observed_at,publication_kind=EXCLUDED.publication_kind;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER sync_cover_source AFTER INSERT OR UPDATE OR DELETE ON social_sync.publications FOR EACH ROW EXECUTE FUNCTION social_sync.sync_cover_source();
INSERT INTO social_sync.cover_sources(display_mode,owner_kind,owner_key,source_sha256,observed_at,publication_kind) SELECT mode,'publication',publication_key,
 CASE WHEN payload->>'coverUrl' IS NULL THEN NULL ELSE encode(sha256(convert_to(payload->>'coverUrl','UTF8')),'hex') END,observed_at,payload->>'kind'
 FROM social_sync.publications CROSS JOIN (VALUES('trial'),('retained')) modes(mode);

ALTER TABLE social_sync.cover_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.cover_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.cover_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY cover_meta_reader ON social_sync.cover_meta FOR SELECT TO nb_social_reader USING(true);
CREATE POLICY cover_sources_reader ON social_sync.cover_sources FOR SELECT TO nb_social_reader USING(
 social_sync.cover_owner_visible(display_mode,owner_kind,owner_key));
CREATE POLICY cover_sources_worker_insert ON social_sync.cover_sources FOR INSERT TO nb_social_media_worker WITH CHECK(owner_kind='collection' AND
 social_sync.cover_collection_time(display_mode,owner_key,observed_at));
CREATE POLICY cover_sources_worker_update ON social_sync.cover_sources FOR UPDATE TO nb_social_media_worker
 USING(owner_kind='collection' AND social_sync.cover_owner_visible(display_mode,owner_kind,owner_key))
 WITH CHECK(owner_kind='collection' AND social_sync.cover_collection_time(display_mode,owner_key,observed_at));
CREATE POLICY cover_bindings_reader ON social_sync.cover_bindings FOR SELECT TO nb_social_reader USING(
 social_sync.cover_owner_visible(display_mode,owner_kind,owner_key) AND social_sync.cover_source_matches(display_mode,owner_kind,owner_key,source_sha256));
CREATE POLICY cover_bindings_worker_select ON social_sync.cover_bindings FOR SELECT TO nb_social_media_worker USING(social_sync.cover_owner_visible(display_mode,owner_kind,owner_key));
CREATE POLICY cover_bindings_worker_insert ON social_sync.cover_bindings FOR INSERT TO nb_social_media_worker WITH CHECK(
 social_sync.cover_owner_visible(display_mode,owner_kind,owner_key) AND social_sync.cover_source_matches(display_mode,owner_kind,owner_key,source_sha256));
CREATE POLICY cover_bindings_worker_update ON social_sync.cover_bindings FOR UPDATE TO nb_social_media_worker
 USING(social_sync.cover_owner_visible(display_mode,owner_kind,owner_key))
 WITH CHECK(social_sync.cover_owner_visible(display_mode,owner_kind,owner_key) AND social_sync.cover_source_matches(display_mode,owner_kind,owner_key,source_sha256));
REVOKE ALL ON social_sync.cover_meta,social_sync.cover_sources,social_sync.cover_bindings FROM PUBLIC,anon,authenticated,service_role,nb_reader,nb_social_worker,nb_social_reader,nb_social_media_worker;
REVOKE EXECUTE ON FUNCTION social_sync.cover_owner_visible(text,text,text),social_sync.cover_collection_time(text,text,text),social_sync.valid_cover_media(jsonb,text,text,integer),
 social_sync.valid_cover_files(jsonb,text,text),social_sync.cover_asset_id(text,text,text,text),social_sync.cover_source_matches(text,text,text,text),social_sync.sync_cover_source()
 FROM PUBLIC,anon,authenticated,service_role,nb_reader,nb_social_worker,nb_social_reader,nb_social_media_worker;
GRANT SELECT ON social_sync.cover_meta,social_sync.cover_sources,social_sync.cover_bindings TO nb_social_reader;
GRANT INSERT(display_mode,owner_kind,owner_key,source_sha256,observed_at),UPDATE(source_sha256,observed_at) ON social_sync.cover_sources TO nb_social_media_worker;
GRANT INSERT(display_mode,owner_kind,owner_key,source_sha256,files),UPDATE(source_sha256,files) ON social_sync.cover_bindings TO nb_social_media_worker;
GRANT EXECUTE ON FUNCTION social_sync.valid_time(jsonb),social_sync.collection_exact_keys(jsonb,text[]) TO nb_social_media_worker;
GRANT EXECUTE ON FUNCTION social_sync.cover_owner_visible(text,text,text),social_sync.cover_collection_time(text,text,text),social_sync.valid_cover_media(jsonb,text,text,integer),
 social_sync.valid_cover_files(jsonb,text,text),social_sync.cover_asset_id(text,text,text,text),social_sync.cover_source_matches(text,text,text,text) TO nb_social_reader;
COMMIT;
