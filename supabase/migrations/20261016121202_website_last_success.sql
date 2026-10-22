-- Independent opt-in reader availability extension; no policy or lease change.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('nb_v2.current_snapshot()')
      AND md5(prosrc)='756c0fddecf323ea5f0961b16f8b8128' AND prosecdef) OR
     NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb)')
      AND md5(prosrc)='caf3ba417e0357920cdfa8c8c4091be2' AND prosecdef) THEN
    RAISE EXCEPTION 'NB_AVAILABILITY_BASE_MISMATCH';
  END IF;
END $$;
CREATE SCHEMA nb_availability;
REVOKE ALL ON SCHEMA nb_availability FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_availability REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_availability.policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  retain_last_success boolean NOT NULL DEFAULT false
);
INSERT INTO nb_availability.policy VALUES (true,false);
ALTER TABLE nb_availability.policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_availability.policy FROM PUBLIC,nb_reader,nb_writer;

CREATE OR REPLACE FUNCTION nb_v2.current_snapshot() RETURNS nb_v2.runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; s nb_v2.state;
BEGIN
  SELECT * INTO s FROM nb_v2.state;
  SELECT * INTO r FROM nb_v2.runs WHERE id=s.current_run;
  IF r.id IS NULL OR r.status<>'published' OR r.epoch<>s.epoch OR
    (r.valid_until<=statement_timestamp() AND NOT COALESCE(
      (SELECT retain_last_success FROM nb_availability.policy WHERE singleton),false)) THEN
    RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  RETURN r;
END $$;

-- Thumbnail writes formerly inherited expiry from current_snapshot. Preserve
-- that deadline explicitly while allowing the reader to retain existing rows.
ALTER FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) SET SCHEMA nb_availability;
ALTER FUNCTION nb_availability.register_media(text,uuid,text,text,text,integer,jsonb) RENAME TO register_qualified_legacy;
REVOKE ALL ON FUNCTION nb_availability.register_qualified_legacy(text,uuid,text,text,text,integer,jsonb) FROM PUBLIC,nb_reader,nb_writer;
CREATE FUNCTION nb_thumbnail_api.register_media(p_version text,p_run uuid,p_parent text,p_sha text,p_fingerprint text,p_width integer,p_descriptor jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
BEGIN
  IF p_version='v2' AND NOT EXISTS (SELECT FROM nb_v2.runs r JOIN nb_v2.state s ON s.current_run=r.id
    WHERE r.id=p_run AND r.status='published' AND r.epoch=s.epoch AND r.valid_until>statement_timestamp()) THEN
    RAISE EXCEPTION 'NB_UNAVAILABLE';
  END IF;
  PERFORM nb_availability.register_qualified_legacy(p_version,p_run,p_parent,p_sha,p_fingerprint,p_width,p_descriptor);
END $$;
REVOKE ALL ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) FROM PUBLIC,nb_reader;
GRANT EXECUTE ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) TO nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nb_availability FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_availability FROM %I',role_name);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_availability FROM %I',role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
INSERT INTO nb_v2.migrations(version) VALUES('001-website-last-success');
-- Installation owner records the reviewed file hash, then separately enables
-- retain_last_success after checking current scope and the drained writer window.
COMMIT;
