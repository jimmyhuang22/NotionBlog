-- Independent, default-off read extension; requires the three scoped read migrations.
-- No eligible IDs are accepted by the API. Only this statement's candidate loop
-- supplies p_records to the private helper; no eligibility survives the statement.
BEGIN;
INSERT INTO nb_read.migrations VALUES(5,NULL);

CREATE FUNCTION nb_read.search_scope_known(p_run uuid,p_records jsonb,p_hrefs text[],p_ids text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH known AS MATERIALIZED (SELECT DISTINCT r->'item'->>'id' AS id FROM jsonb_array_elements(p_records) r), hrefs AS MATERIALIZED (SELECT DISTINCT unnest(p_hrefs) AS href),
  referenced_links AS MATERIALIZED (
    SELECT x.id,x.item->>'href' AS href FROM nb_v2.records x JOIN hrefs h ON h.href=x.item->>'href' WHERE x.run_id=p_run
  ), ids AS MATERIALIZED (SELECT DISTINCT id FROM unnest(p_ids) id WHERE id ~ '^a1\.[a-f0-9]{64}$'),
  referenced_media AS MATERIALIZED (SELECT m.asset_id,m.owner_page_id FROM nb_v2.media m JOIN ids ON ids.id=m.asset_id WHERE m.run_id=p_run),
  owners AS MATERIALIZED (SELECT DISTINCT owner_page_id FROM referenced_media),
  eligible_owners AS MATERIALIZED (SELECT owner_page_id FROM owners WHERE owner_page_id IN(SELECT id FROM known) OR nb_v2.record_eligible(p_run,owner_page_id))
  SELECT jsonb_build_object('runId',p_run,'revision',s.revision::text,'schemaDigest',s.schema_digest,'records',p_records,
    'links',(SELECT COALESCE(jsonb_agg(h.href),'[]') FROM referenced_links h WHERE h.id IN(SELECT id FROM known) OR nb_v2.record_eligible(p_run,h.id)),
    'mediaIds',(SELECT COALESCE(jsonb_agg(m.asset_id),'[]') FROM referenced_media m JOIN eligible_owners e USING(owner_page_id)))
  FROM nb_v2.state s WHERE singleton
$$;

CREATE FUNCTION nb_read_api.read_search_filtered_scope(p_mode text,p_kinds text[],p_probes text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; parts jsonb; items jsonb[]:=ARRAY[]::jsonb[];
  hrefs text[]:=ARRAY[]::text[]; ids text[]:=ARRAY[]::text[]; link_ids text[]; media_ids text[]; used integer:=2; n integer:=0; raw_text text; has_notes boolean:=false;
BEGIN
  IF p_probes IS NULL OR cardinality(p_probes)>1 OR array_ndims(p_probes)>1 OR cardinality(p_probes)=1 AND array_lower(p_probes,1)<>1 OR EXISTS(SELECT FROM unnest(p_probes) probe WHERE probe IS NULL OR
    char_length(probe)<3 OR octet_length(probe)>2048 OR translate(probe,'[]()|?:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','') ~ '[\x00-\x7f]') THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF cardinality(p_probes)=0 THEN RETURN nb_read_api.read_search_parts(p_mode,p_kinds); END IF;
  r:=nb_read.current_snapshot(p_mode);
  IF p_kinds IS NULL OR cardinality(p_kinds)>10 OR EXISTS(SELECT FROM unnest(p_kinds) k WHERE k IS NULL OR k NOT IN
    ('status','course','study-note','post','album','book','movie','game','project','page')) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN SELECT rec.* FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=ANY(p_kinds)
      AND nb_v2.record_eligible(r.id,rec.id) ORDER BY rec.id LIMIT 20001 LOOP
    n:=n+1; IF n>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    raw_text:=x.item::text||COALESCE(x.document::text,'');
    IF NOT (raw_text ~ ALL(p_probes)) THEN CONTINUE; END IF;
    -- Only records qualified and matched in this statement enter the known set.
    IF x.kind='study-note' THEN has_notes:=true; END IF;
    SELECT COALESCE(jsonb_agg(p),'[]') INTO parts FROM nb_read.search_parts(x.document->'blocks') p;
    SELECT array_agg(DISTINCT p->>1) FILTER(WHERE p->>1 IS NOT NULL),array_agg(DISTINCT p->>2) FILTER(WHERE p->>2 IS NOT NULL)
      INTO link_ids,media_ids FROM jsonb_array_elements(parts) p WHERE jsonb_typeof(p)='array';
    hrefs:=array_append(hrefs,x.item->>'href')||COALESCE(link_ids,ARRAY[]::text[]);
    ids:=ids||COALESCE(media_ids,ARRAY[]::text[]);
    entry:=jsonb_build_object('item',jsonb_build_object('id',x.item->'id','kind',x.item->'kind',
      'slug',x.item->'slug','href',x.item->'href','title',x.item->'title','summary',x.item->'summary','updatedAt',x.item->'updatedAt'),
      'document',NULL,'parts',parts);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>33554432 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  IF has_notes THEN
    RETURN nb_read.search_scope_known(r.id,to_jsonb(items),hrefs,ids);
  END IF;
  RETURN nb_read.search_scope(r.id,to_jsonb(items),hrefs,ids);
END $$;

CREATE FUNCTION nb_read_api.check_search_filtered_scope(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM nb_read.migrations WHERE version=5 AND digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;

-- Revoke insecure default grants in the same transaction as creation.
REVOKE EXECUTE ON FUNCTION nb_read.search_scope_known(uuid,jsonb,text[],text[]) FROM PUBLIC,nb_reader,nb_writer;
REVOKE EXECUTE ON FUNCTION nb_read_api.read_search_filtered_scope(text,text[],text[]),nb_read_api.check_search_filtered_scope(text) FROM PUBLIC,nb_writer;
GRANT EXECUTE ON FUNCTION nb_read_api.read_search_filtered_scope(text,text[],text[]),nb_read_api.check_search_filtered_scope(text) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_read.search_scope_known(uuid,jsonb,text[],text[]),nb_read_api.read_search_filtered_scope(text,text[],text[]),nb_read_api.check_search_filtered_scope(text) FROM %I',role_name);
  END LOOP;
END $$;
-- The installation owner must verify the reviewed bytes, then register their SHA
-- in version=5. This file does not enable a mode or modify retained content.
COMMIT;
