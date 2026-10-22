-- Additive website read capability. The frozen worker v1 migration is unchanged.
BEGIN;
CREATE TABLE nb.reader_migrations(version text PRIMARY KEY,digest text,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO nb.reader_migrations(version) VALUES('001-status');
ALTER TABLE nb.reader_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb.reader_migrations FROM PUBLIC,nb_reader,nb_writer;

CREATE FUNCTION nb.status_year(p_item jsonb,p_zone text) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,nb,pg_temp AS $$
  SELECT CASE WHEN p_item->'recordedAt'->>'start' IS NULL THEN NULL
    WHEN p_item->'recordedAt'->>'precision'='date' THEN left(p_item->'recordedAt'->>'start',4)::integer
    ELSE extract(year FROM (p_item->'recordedAt'->>'start')::timestamptz AT TIME ZONE p_zone)::integer END
$$;

CREATE FUNCTION nb_api.read_status(p_zone text,p_filters jsonb,p_offset integer,p_limit integer,p_run uuid,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE base jsonb; r uuid; result jsonb; n integer;
BEGIN
  IF p_zone IS NULL OR p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF p_filters?'year' AND p_filters->>'year'<>'undated' AND
    (p_filters->>'year' !~ '^[1-9][0-9]{0,3}$') THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  -- Core RPC supplies the same qualification, cursor fence, link and media projection.
  base:=nb_api.read_content('status',NULL,NULL,'{}',0,1,p_run,p_revision,false);
  r:=(base->>'runId')::uuid;
  WITH selected AS (
    SELECT x.*,(x.item->'recordedAt'->>'start')::timestamptz AS occurred
    FROM nb.records x WHERE x.run_id=r AND x.kind='status' AND nb.record_eligible(r,x.id)
      AND (NOT p_filters?'tag' OR (x.item->'tags') ? (p_filters->>'tag'))
      AND (NOT p_filters?'year' OR CASE WHEN p_filters->>'year'='undated' THEN nb.status_year(x.item,p_zone) IS NULL
        ELSE nb.status_year(x.item,p_zone)=(p_filters->>'year')::integer END)
  ), page AS (
    SELECT * FROM selected ORDER BY
      CASE WHEN COALESCE(p_filters->>'order','date-desc')='date-desc' THEN occurred END DESC NULLS LAST,
      CASE WHEN p_filters->>'order'='date-asc' THEN occurred END ASC NULLS LAST,
      item->>'title' COLLATE "C",id LIMIT p_limit+1 OFFSET p_offset
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('item',item,'document',document)),'[]'),count(*) INTO result,n FROM page;
  IF n>p_limit THEN result:=result-p_limit; END IF;
  RETURN base || jsonb_build_object('readerCapability','notionblog-status-read-v1','records',result,'hasMore',n>p_limit);
END $$;

CREATE FUNCTION nb_api.status_years(p_zone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE r nb.runs; years jsonb; undated bigint;
BEGIN
  IF p_zone IS NULL THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  r:=nb.current_snapshot();
  WITH counts AS (
    SELECT nb.status_year(x.item,p_zone) AS year,count(*) AS count
    FROM nb.records x WHERE x.run_id=r.id AND x.kind='status' AND nb.record_eligible(r.id,x.id)
    GROUP BY nb.status_year(x.item,p_zone)
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('year',year,'count',count) ORDER BY year DESC) FILTER (WHERE year IS NOT NULL),'[]'),
    COALESCE(sum(count) FILTER (WHERE year IS NULL),0) INTO years,undated FROM counts;
  RETURN jsonb_build_object('schemaDigest',(SELECT schema_digest FROM nb.state),'readerCapability','notionblog-status-read-v1',
    'years',years,'undatedCount',undated,'timeZone',p_zone);
END $$;

REVOKE EXECUTE ON FUNCTION nb.status_year(jsonb,text),nb_api.read_status(text,jsonb,integer,integer,uuid,bigint),nb_api.status_years(text) FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON nb.reader_migrations FROM %I',role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION nb.status_year(jsonb,text),nb_api.read_status(text,jsonb,integer,integer,uuid,bigint),nb_api.status_years(text) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_api.read_status(text,jsonb,integer,integer,uuid,bigint),nb_api.status_years(text) TO nb_reader;
COMMIT;
