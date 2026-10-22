-- Independent opt-in control plane. Installing does not activate caching or change frozen protocols.
BEGIN;
CREATE SCHEMA nb_cache;
CREATE SCHEMA nb_cache_api;
REVOKE ALL ON SCHEMA nb_cache,nb_cache_api FROM PUBLIC;
CREATE ROLE nb_cache_operator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE nb_cache_publisher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE TABLE nb_cache.state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1),enabled boolean NOT NULL DEFAULT false,generation bigint NOT NULL DEFAULT 0);
INSERT INTO nb_cache.state VALUES(true,1,false,0);
CREATE TABLE nb_cache.events(id uuid PRIMARY KEY,scope text NOT NULL CHECK(scope IN ('content','social','media','withdraw')),publication_version text NOT NULL,payload jsonb NOT NULL,generation bigint NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz);
ALTER TABLE nb_cache.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_cache.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_cache FROM PUBLIC,nb_reader,nb_writer,nb_cache_operator,nb_cache_publisher;

CREATE FUNCTION nb_cache_api.read_stamp() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',c.version,'enabled',c.enabled,'stamp',concat_ws(':',s.schema_digest,s.current_run::text,s.revision::text,s.epoch::text,c.generation::text))
 FROM nb_cache.state c CROSS JOIN nb_v2.state s WHERE c.singleton AND s.singleton
$$;

-- The plan contains publication relations only, never credentials, original bodies or storage secrets.
CREATE FUNCTION nb_cache_api.plan_withdraw(p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; pages jsonb; assets jsonb; shared boolean; ids text[]; result jsonb;
BEGIN
 IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'NB_CACHE_TARGET'; END IF;
 SELECT * INTO s FROM nb_v2.state WHERE singleton;
 IF (SELECT count(*) FROM nb_v2.records r WHERE r.run_id=s.current_run AND (r.id=p_id OR r.item->>'href'=p_id))<>1 THEN RAISE EXCEPTION 'NB_CACHE_TARGET'; END IF;
 SELECT r.id INTO p_id FROM nb_v2.records r WHERE r.run_id=s.current_run AND (r.id=p_id OR r.item->>'href'=p_id);
 IF s.current_run IS NULL OR NOT EXISTS(SELECT FROM nb_v2.runs r WHERE r.id=s.current_run AND r.status='published') OR
    NOT EXISTS(SELECT FROM nb_v2.records r WHERE r.run_id=s.current_run AND r.id=p_id AND nb_v2.record_eligible(r.run_id,r.id)) THEN RAISE EXCEPTION 'NB_CACHE_TARGET'; END IF;
 WITH RECURSIVE subtree AS (
   SELECT id FROM nb_v2.records WHERE run_id=s.current_run AND id=p_id
   UNION
   SELECT r.id FROM nb_v2.records r JOIN subtree p ON r.parent_id=p.id OR r.course_id=p.id WHERE r.run_id=s.current_run
 ) SELECT array_agg(id ORDER BY id) INTO ids FROM subtree;
 IF cardinality(ids)>20000 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',r.id,'href',r.item->>'href','kind',r.kind,'slug',r.item->>'slug') ORDER BY r.id) INTO pages
 FROM nb_v2.records r WHERE r.run_id=s.current_run AND r.id=ANY(ids);
 SELECT coalesce(jsonb_agg(asset_id ORDER BY asset_id),'[]') INTO assets FROM (
   SELECT DISTINCT asset_id FROM nb_v2.media WHERE owner_page_id=ANY(ids) LIMIT 40001
 ) m;
 IF jsonb_array_length(assets)>40000 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
 -- Shared physical bytes are fine. A shared owner URL needs independent rebinding first.
 SELECT EXISTS(
   SELECT FROM nb_v2.records r CROSS JOIN LATERAL jsonb_path_query(jsonb_build_array(r.item,r.document),'$.**.src') v
   WHERE r.run_id=s.current_run AND NOT(r.id=ANY(ids)) AND nb_v2.record_eligible(r.run_id,r.id)
   AND jsonb_typeof(v)='string' AND split_part(v#>>'{}','?',1) IN (
     SELECT '/media/v2/'||(a#>>'{}') FROM jsonb_array_elements(assets) a
   )
 ) INTO shared;
 result:=jsonb_build_object('version',1,'target',p_id,'runId',s.current_run,'revision',s.revision::text,'epoch',s.epoch::text,'pages',pages,'assets',assets,'sharedOwnerUrl',shared,'leaseActive',s.lease_run IS NOT NULL);
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION nb_cache_api.withdraw(p_event uuid,p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; prior nb_cache.events; actual jsonb; gen bigint;
BEGIN
 IF p_event IS NULL OR p_plan IS NULL OR octet_length(p_plan::text)>8388608 THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 PERFORM 1 FROM nb_cache.state WHERE singleton FOR UPDATE;
 SELECT * INTO prior FROM nb_cache.events WHERE id=p_event;
 IF FOUND THEN
   IF prior.scope<>'withdraw' OR prior.payload<>p_plan THEN RAISE EXCEPTION 'NB_CACHE_EVENT_CONFLICT'; END IF;
   RETURN jsonb_build_object('id',prior.id,'generation',prior.generation::text,'status',prior.status);
 END IF;
 SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE NOWAIT;
 -- Never cancel somebody else's staging run. The caller must wait for the existing owner.
 IF s.lease_run IS NOT NULL THEN RAISE EXCEPTION 'NB_CACHE_SYNC_BUSY'; END IF;
 actual:=nb_cache_api.plan_withdraw(p_plan->>'target');
 IF actual<>p_plan OR (actual->>'sharedOwnerUrl')::boolean THEN RAISE EXCEPTION 'NB_CACHE_PLAN_CHANGED'; END IF;
 PERFORM nb_v2_api.set_denied(p_plan->>'target',true);
 UPDATE nb_cache.state SET generation=generation+1 WHERE singleton RETURNING generation INTO gen;
 INSERT INTO nb_cache.events(id,scope,publication_version,payload,generation) VALUES(p_event,'withdraw',p_plan->>'revision',p_plan,gen);
 RETURN jsonb_build_object('id',p_event,'generation',gen::text,'status','pending');
END $$;

CREATE FUNCTION nb_cache_api.enqueue_refresh(p_event uuid,p_scope text,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior nb_cache.events; gen bigint;
BEGIN
 IF p_event IS NULL OR p_scope IS NULL OR p_scope NOT IN ('content','social','media') OR p_version IS NULL OR p_version !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NB_CACHE_EVENT'; END IF;
 PERFORM 1 FROM nb_cache.state WHERE singleton FOR UPDATE;
 SELECT * INTO prior FROM nb_cache.events WHERE id=p_event;
 IF FOUND THEN
   IF prior.scope<>p_scope OR prior.publication_version<>p_version THEN RAISE EXCEPTION 'NB_CACHE_EVENT_CONFLICT'; END IF;
   RETURN jsonb_build_object('id',prior.id,'generation',prior.generation::text,'status',prior.status);
 END IF;
 UPDATE nb_cache.state SET generation=generation+1 WHERE singleton RETURNING generation INTO gen;
 INSERT INTO nb_cache.events(id,scope,publication_version,payload,generation) VALUES(p_event,p_scope,p_version,'{}',gen);
 RETURN jsonb_build_object('id',p_event,'generation',gen::text,'status','pending');
END $$;
CREATE FUNCTION nb_cache_api.read_event(p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',e.id,'scope',e.scope,'generation',e.generation::text,'status',e.status)
 FROM nb_cache.events e WHERE e.id=p_event
$$;
CREATE FUNCTION nb_cache_api.read_withdraw(p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('event',nb_cache_api.read_event(e.id),'plan',e.payload,'denied',EXISTS(SELECT FROM nb_v2.denied d WHERE d.id=e.payload->>'target'))
 FROM nb_cache.events e WHERE e.id=p_event AND e.scope='withdraw'
$$;
CREATE FUNCTION nb_cache_api.complete_event(p_event uuid,p_generation bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE nb_cache.events SET status='complete',completed_at=coalesce(completed_at,clock_timestamp()) WHERE id=p_event AND generation=p_generation;
 RETURN FOUND;
END $$;
CREATE FUNCTION nb_cache_api.complete_refresh_event(p_event uuid,p_generation bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE nb_cache.events SET status='complete',completed_at=coalesce(completed_at,clock_timestamp()) WHERE id=p_event AND generation=p_generation AND scope<>'withdraw';
 RETURN FOUND;
END $$;
CREATE FUNCTION nb_cache_api.pending_events() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'scope',scope,'generation',generation::text,'status',status) ORDER BY generation),'[]')
 FROM (SELECT id,scope,generation,status FROM nb_cache.events WHERE status='pending' ORDER BY generation LIMIT 100) q
$$;
-- Capture a successful full publication in the same transaction, including power loss before the host hook.
CREATE FUNCTION nb_cache.on_content_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v text; event_id uuid;
BEGIN
 IF NOT(SELECT enabled FROM nb_cache.state WHERE singleton) OR NEW.current_run IS NULL OR NEW.current_run IS NOT DISTINCT FROM OLD.current_run THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT FROM nb_v2.runs WHERE id=NEW.current_run AND status='published') THEN RAISE EXCEPTION 'NB_CACHE_PUBLICATION'; END IF;
 v:=encode(sha256(convert_to(concat_ws(':',NEW.current_run::text,NEW.revision::text,NEW.epoch::text),'UTF8')),'hex');
 event_id:=(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid;
 PERFORM nb_cache_api.enqueue_refresh(event_id,'content',v);
 RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION nb_cache.on_content_publication() FROM PUBLIC;
CREATE TRIGGER nb_cache_content_publication AFTER UPDATE OF current_run ON nb_v2.state
FOR EACH ROW EXECUTE FUNCTION nb_cache.on_content_publication();
-- Successful social/thumbnail transactions also leave a durable event. One event per scope per transaction.
CREATE FUNCTION nb_cache.on_projection_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v text; event_id uuid;
BEGIN
 IF NOT(SELECT enabled FROM nb_cache.state WHERE singleton) THEN RETURN NULL; END IF;
 v:=encode(sha256(convert_to('nb-cache:'||TG_ARGV[0]||':'||txid_current()::text||':'||transaction_timestamp()::text,'UTF8')),'hex');
 event_id:=(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid;
 PERFORM nb_cache_api.enqueue_refresh(event_id,TG_ARGV[0],v);
 RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION nb_cache.on_projection_change() FROM PUBLIC;
DO $$ DECLARE name text; scope text; BEGIN
 FOREACH name IN ARRAY ARRAY['social_sync.bindings','social_sync.publications','social_sync.works','social_sync.website_visibility',
  'social_sync.collection_bindings','social_sync.collection_states','social_sync.collection_visibility','social_sync.collection_member_reviews',
  'social_sync.collection_standalone_overrides','social_sync.retained_publications','social_sync.retained_collections',
  'social_sync.collection_playback_links','social_sync.bilibili_accounts','social_sync.xiaohongshu_accounts',
  'social_sync.bilibili_auto_bindings','social_sync.xiaohongshu_auto_bindings','social_sync.cover_bindings','nb_thumbnails.media'] LOOP
  IF to_regclass(name) IS NOT NULL THEN
   scope:=CASE WHEN name IN ('social_sync.cover_bindings','nb_thumbnails.media') THEN 'media' ELSE 'social' END;
   EXECUTE format('CREATE TRIGGER nb_cache_projection_change AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION nb_cache.on_projection_change(%L)',to_regclass(name),scope);
  END IF;
 END LOOP;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_cache_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_cache_api TO nb_reader,nb_cache_operator,nb_cache_publisher;
GRANT EXECUTE ON FUNCTION nb_cache_api.read_stamp(),nb_cache_api.read_event(uuid) TO nb_reader;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_cache_api TO nb_cache_operator;
GRANT EXECUTE ON FUNCTION nb_cache_api.enqueue_refresh(uuid,text,text),nb_cache_api.pending_events(),nb_cache_api.read_event(uuid),nb_cache_api.complete_refresh_event(uuid,bigint) TO nb_cache_publisher;
COMMIT;
