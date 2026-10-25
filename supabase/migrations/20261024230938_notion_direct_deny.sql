-- Independent, opt-in read capability. Apply once with the original schema owner.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_namespace WHERE nspname='nb' AND nspowner=current_user::regrole) OR
     NOT EXISTS(SELECT FROM pg_catalog.pg_namespace WHERE nspname='nb_v2' AND nspowner=current_user::regrole) OR
     EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='nb_reader' AND
       (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
     NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='nb_reader') THEN
    RAISE EXCEPTION 'NB_DIRECT_POLICY_OWNER';
  END IF;
END $$;
CREATE SCHEMA nb_policy_api;
REVOKE ALL ON SCHEMA nb_policy_api FROM PUBLIC;
DO $$ DECLARE grantee_name text; BEGIN
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(acl.grantee)
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
    WHERE n.nspname='nb_policy_api' AND acl.grantee NOT IN (0,n.nspowner)
  LOOP EXECUTE format('REVOKE ALL ON SCHEMA nb_policy_api FROM %I',grantee_name); END LOOP;
END $$;
CREATE FUNCTION nb_policy_api.check_denied(p_version integer,p_ids text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$DECLARE
  version text;
  flags boolean[];
BEGIN
  IF p_version NOT IN (1,2) OR p_version IS NULL OR p_ids IS NULL OR
    cardinality(p_ids)>256 OR array_ndims(p_ids)>1 OR
    EXISTS(SELECT FROM unnest(p_ids) id WHERE id IS NULL OR id !~ '^[a-f0-9]{32}$') THEN
    RAISE EXCEPTION 'NB_DIRECT_POLICY_INPUT';
  END IF;
  IF p_version=1 THEN
    SELECT epoch::text||':'||revision::text INTO STRICT version FROM nb.state WHERE singleton;
    SELECT COALESCE(array_agg(EXISTS(SELECT FROM nb.denied d WHERE d.id=requested.id) ORDER BY ordinal),ARRAY[]::boolean[])
      INTO flags FROM unnest(p_ids) WITH ORDINALITY AS requested(id,ordinal);
  ELSE
    SELECT epoch::text||':'||revision::text INTO STRICT version FROM nb_v2.state WHERE singleton;
    SELECT COALESCE(array_agg(EXISTS(SELECT FROM nb_v2.denied d WHERE d.id=requested.id) ORDER BY ordinal),ARRAY[]::boolean[])
      INTO flags FROM unnest(p_ids) WITH ORDINALITY AS requested(id,ordinal);
  END IF;
  RETURN jsonb_build_object('revision',version,'denied',to_jsonb(flags));
END;$body$;
-- Remove inherited function defaults as well as PUBLIC execution.
DO $$ DECLARE grantee_name text; BEGIN
  FOR grantee_name IN SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid='nb_policy_api.check_denied(integer,text[])'::regprocedure AND acl.grantee<>p.proowner
  LOOP
    IF grantee_name='PUBLIC' THEN REVOKE ALL ON FUNCTION nb_policy_api.check_denied(integer,text[]) FROM PUBLIC;
    ELSE EXECUTE format('REVOKE ALL ON FUNCTION nb_policy_api.check_denied(integer,text[]) FROM %I',grantee_name); END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA nb_policy_api TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_policy_api.check_denied(integer,text[]) TO nb_reader;
COMMIT;
