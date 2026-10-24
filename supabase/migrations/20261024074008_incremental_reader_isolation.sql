-- Opt-in private synchronization reader. No LOGIN credentials or memberships changed.
BEGIN;
CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA nb_publication_api,nb_delta_api TO nb_delta_reader;
GRANT EXECUTE ON FUNCTION nb_publication_api.check_capability(text),nb_publication_api.read_snapshot(text[],boolean),
 nb_delta_api.check_capability(text),nb_delta_api.read_state(),nb_delta_api.check_reader(text),
 nb_delta_api.read_page(text,text,text),nb_delta_api.verify_operation(uuid,text,text) TO nb_delta_reader;
REVOKE EXECUTE ON FUNCTION nb_delta_api.check_reader(text),nb_delta_api.read_page(text,text,text),
 nb_delta_api.verify_operation(uuid,text,text) FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_delta_api.check_reader(text),nb_delta_api.read_page(text,text,text),nb_delta_api.verify_operation(uuid,text,text) FROM %I',role_name);
 END LOOP;
 IF to_regprocedure('nb_publication_api.read_thumbnail(text,integer,text)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION nb_publication_api.check_thumbnail_capability(text),nb_publication_api.read_thumbnail(text,integer,text) TO nb_delta_reader;
 END IF;
 IF to_regprocedure('nb_delta_api.check_withdrawal_recovery(text)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) TO nb_delta_reader;
 END IF;
END $$;
ALTER TABLE nb_delta.state ADD COLUMN reader_isolation_digest text;
COMMIT;
