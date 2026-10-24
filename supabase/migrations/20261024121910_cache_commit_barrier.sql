-- Independent opt-in commit barrier. Installing leaves the new path disabled.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF EXISTS (
  SELECT FROM (VALUES
 ('nb_cache_api.read_stamp()','174337c7765aebb79e8f7eff5b1e12564adcd17ed5a8dbf81caac751c32cb0f9','sql','s'),
 ('nb_cache_api.plan_withdraw(text)','e02229f95463eb48b25af42ad43a574783441ad5bbc69cb5e428ff4e3cc9b7e3','plpgsql','s'),
 ('nb_cache_api.withdraw(uuid,jsonb)','ee8f2c4a85e4035226c19a7218e9c87d533fca052ebb1d5e6081e65cb9f8431f','plpgsql','v'),
 ('nb_cache_api.enqueue_refresh(uuid,text,text)','e6cd8ba876b7aebd045a9d26742f3dfbcf82b99a003d2a829dcb9dabf9d28992','plpgsql','v'),
 ('nb_cache_api.read_event(uuid)','d6d4dd8bc9a392d999e3106e71c8b1893f9a42cf69175c689c6e2006a8d3166f','sql','s'),
 ('nb_cache_api.read_withdraw(uuid)','8a7704e4870927ac1a5c44a626973169be65c6ec3c8bc803aa58c91cf45930c5','sql','s'),
 ('nb_cache_api.complete_event(uuid,bigint)','7744be3694fbb147cec549d7cde0e50b747da778a8922d1efde7388b875a651e','plpgsql','v'),
 ('nb_cache_api.complete_refresh_event(uuid,bigint)','6b9286d3959fbfd8d899aee2dd490d68fee1c2cee95072e317861c17e46980b3','plpgsql','v'),
 ('nb_cache_api.pending_events()','3a5053081d5f3684c7b55bbcbc8cd9391aa759d135eebd79cd937e81f8836b76','sql','s'),
 ('nb_cache.on_content_publication()','8f10ebc5f8f990fb624444e88e195b0e48a81748d857023feb133585d45a1aff','plpgsql','v'),
 ('nb_cache.on_projection_change()','86cf608028bd6710d0f8dbad18c927fe4e2f7c5211b7c89de2e5572db1519690','plpgsql','v')
  ) expected(signature,sha,language,volatility) LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prokind<>'f' OR p.provolatile::text<>expected.volatility
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname=expected.language) OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
   OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.sha
   OR p.proowner IS DISTINCT FROM (SELECT relowner FROM pg_catalog.pg_class WHERE oid=to_regclass('nb_cache.state'))
 ) THEN RAISE EXCEPTION 'NB_CACHE_COMMIT_BASE_MISMATCH'; END IF;
 IF (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) IS DISTINCT FROM
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid=to_regclass('nb_cache.state')) THEN
  RAISE EXCEPTION 'NB_CACHE_COMMIT_OWNER'; END IF;
END $guard$;
CREATE TABLE nb_cache.commit_config(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL DEFAULT 1 CHECK(version=1),enabled boolean NOT NULL DEFAULT false);
INSERT INTO nb_cache.commit_config(singleton) VALUES(true);
CREATE TABLE nb_cache.commit_intents(id uuid PRIMARY KEY,
 scope text NOT NULL CHECK(scope IN ('content','social','media')),
 publication_version text NOT NULL CHECK(publication_version ~ '^[a-f0-9]{64}$'),
 transaction_id bigint NOT NULL CHECK(transaction_id>0));
ALTER TABLE nb_cache.commit_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_cache.commit_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_cache.commit_config,nb_cache.commit_intents FROM PUBLIC,nb_reader,nb_writer,nb_cache_operator,nb_cache_publisher;

CREATE FUNCTION nb_cache.stage_commit_refresh(p_event uuid,p_scope text,p_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg nb_cache.commit_config; prior nb_cache.commit_intents;
BEGIN
 IF p_event IS NULL OR p_scope IS NULL OR p_scope NOT IN ('content','social','media') OR p_version IS NULL OR p_version !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NB_CACHE_EVENT'; END IF;
 SELECT * INTO cfg FROM nb_cache.commit_config WHERE singleton;
 IF NOT FOUND OR cfg.version IS DISTINCT FROM 1 OR cfg.enabled IS NULL THEN RAISE EXCEPTION 'NB_CACHE_COMMIT_CONFIG'; END IF;
 IF NOT cfg.enabled THEN PERFORM nb_cache_api.enqueue_refresh(p_event,p_scope,p_version); RETURN; END IF;
 INSERT INTO nb_cache.commit_intents(id,scope,publication_version,transaction_id)
 VALUES(p_event,p_scope,p_version,txid_current()) ON CONFLICT(id) DO NOTHING;
 SELECT * INTO prior FROM nb_cache.commit_intents WHERE id=p_event;
 -- SET CONSTRAINTS IMMEDIATE can already have flushed and removed this row.
 IF FOUND AND (prior.scope<>p_scope OR prior.publication_version<>p_version OR prior.transaction_id<>txid_current()) THEN RAISE EXCEPTION 'NB_CACHE_EVENT_CONFLICT'; END IF;
END $$;
CREATE FUNCTION nb_cache.flush_commit_refresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actual nb_cache.commit_intents;
BEGIN
 SELECT * INTO actual FROM nb_cache.commit_intents WHERE id=NEW.id;
 IF NOT FOUND OR actual.transaction_id<>txid_current() OR actual IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'NB_CACHE_COMMIT_INTENT'; END IF;
 -- Already-staged work must finish even if the activation flag is changed.
 PERFORM nb_cache_api.enqueue_refresh(NEW.id,NEW.scope,NEW.publication_version);
 DELETE FROM nb_cache.commit_intents WHERE id=NEW.id AND transaction_id=txid_current();
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_CACHE_COMMIT_INTENT'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nb_cache_commit_refresh AFTER INSERT ON nb_cache.commit_intents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nb_cache.flush_commit_refresh();
CREATE OR REPLACE FUNCTION nb_cache.on_content_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v text; event_id uuid;
BEGIN
 IF NOT(SELECT enabled FROM nb_cache.state WHERE singleton) OR NEW.current_run IS NULL OR NEW.current_run IS NOT DISTINCT FROM OLD.current_run THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT FROM nb_v2.runs WHERE id=NEW.current_run AND status='published') THEN RAISE EXCEPTION 'NB_CACHE_PUBLICATION'; END IF;
 v:=encode(sha256(convert_to(concat_ws(':',NEW.current_run::text,NEW.revision::text,NEW.epoch::text),'UTF8')),'hex');
 event_id:=(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid;
 PERFORM nb_cache.stage_commit_refresh(event_id,'content',v);
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION nb_cache.on_projection_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v text; event_id uuid;
BEGIN
 IF NOT(SELECT enabled FROM nb_cache.state WHERE singleton) THEN RETURN NULL; END IF;
 v:=encode(sha256(convert_to('nb-cache:'||TG_ARGV[0]||':'||txid_current()::text||':'||transaction_timestamp()::text,'UTF8')),'hex');
 event_id:=(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid;
 PERFORM nb_cache.stage_commit_refresh(event_id,TG_ARGV[0],v);
 RETURN NULL;
END $$;
CREATE FUNCTION nb_cache_api.read_commit_barrier() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',version,'enabled',enabled) FROM nb_cache.commit_config WHERE singleton
$$;
REVOKE EXECUTE ON FUNCTION nb_cache.stage_commit_refresh(uuid,text,text),nb_cache.flush_commit_refresh(),nb_cache_api.read_commit_barrier() FROM PUBLIC,nb_reader,nb_writer,nb_cache_operator,nb_cache_publisher;
-- Remove every inherited default grantee from these NEW objects, not only known app roles.
DO $acl$ DECLARE actor text; BEGIN
 FOR actor IN
  SELECT DISTINCT r.rolname FROM (
   SELECT c.relowner AS owner,coalesce(c.relacl,acldefault('r',c.relowner)) AS acl FROM pg_catalog.pg_class c
    WHERE c.oid IN ('nb_cache.commit_config'::regclass,'nb_cache.commit_intents'::regclass)
   UNION ALL
   SELECT p.proowner,coalesce(p.proacl,acldefault('f',p.proowner)) FROM pg_catalog.pg_proc p
    WHERE p.oid IN ('nb_cache.stage_commit_refresh(uuid,text,text)'::regprocedure,
     'nb_cache.flush_commit_refresh()'::regprocedure,'nb_cache_api.read_commit_barrier()'::regprocedure)
  ) objects CROSS JOIN LATERAL aclexplode(objects.acl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE a.grantee<>objects.owner
 LOOP
  EXECUTE format('REVOKE ALL ON nb_cache.commit_config,nb_cache.commit_intents FROM %I',actor);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_cache.stage_commit_refresh(uuid,text,text),nb_cache.flush_commit_refresh(),nb_cache_api.read_commit_barrier() FROM %I',actor);
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION nb_cache_api.read_commit_barrier() TO nb_cache_operator;
COMMIT;
