-- Opt-in compact withdrawal. The original v1 plan, event and reader functions are unchanged.
BEGIN;

CREATE FUNCTION nb_cache_api.plan_withdraw_compact(p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; pages jsonb; ids text[]; shared boolean; result jsonb;
 asset text; asset_count bigint:=0; sample text:=NULL;
 asset_digest bytea:=sha256(convert_to('notionblog:withdraw-assets:v2:start','UTF8'));
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
 ) SELECT array_agg(id ORDER BY id COLLATE "C") INTO ids FROM subtree;
 IF cardinality(ids)>20000 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',r.id,'href',r.item->>'href','kind',r.kind,'slug',r.item->>'slug') ORDER BY r.id COLLATE "C") INTO pages
 FROM nb_v2.records r WHERE r.run_id=s.current_run AND r.id=ANY(ids);
 -- The row cursor bounds the exported summary, not the sort or historical scan cost.
 FOR asset IN SELECT DISTINCT m.asset_id COLLATE "C" FROM nb_v2.media m
   WHERE m.owner_page_id=ANY(ids) ORDER BY 1 LIMIT 400001
 LOOP
   asset_count:=asset_count+1;
   IF asset_count>400000 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
   IF octet_length(asset)<>67 OR asset COLLATE "C" !~ '^a1[.][a-f0-9]{64}$' THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
   IF sample IS NULL THEN sample:=asset; END IF;
   asset_digest:=sha256(decode('01','hex')||asset_digest||convert_to(asset,'UTF8'));
 END LOOP;
 asset_digest:=sha256(decode('02','hex')||asset_digest||int8send(asset_count));
 -- A historical owner URL used by another currently eligible page still blocks withdrawal.
 SELECT EXISTS(
   SELECT FROM nb_v2.records r CROSS JOIN LATERAL jsonb_path_query(jsonb_build_array(r.item,r.document),'$.**.src') v
   WHERE r.run_id=s.current_run AND NOT(r.id=ANY(ids)) AND nb_v2.record_eligible(r.run_id,r.id)
   AND jsonb_typeof(v)='string' AND EXISTS(
     SELECT FROM nb_v2.media m WHERE m.owner_page_id=ANY(ids)
       AND split_part(v#>>'{}','?',1)='/media/v2/'||m.asset_id
   )
 ) INTO shared;
 result:=jsonb_build_object('version',2,'target',p_id,'runId',s.current_run,'revision',s.revision::text,'epoch',s.epoch::text,
   'pages',pages,'assetSummary',jsonb_build_object('algorithm','nb-withdraw-assets-sha256-v1','count',asset_count,
   'digest',encode(asset_digest,'hex'),'sample',sample),'sharedOwnerUrl',shared,'leaseActive',s.lease_run IS NOT NULL);
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'NB_CACHE_PLAN_LIMIT'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION nb_cache_api.withdraw_compact(p_event uuid,p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; prior nb_cache.events; actual jsonb; gen bigint; summary jsonb;
BEGIN
 IF p_event IS NULL OR p_plan IS NULL OR octet_length(p_plan::text)>8388608 OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p_plan) k) IS DISTINCT FROM
    ARRAY['assetSummary','epoch','leaseActive','pages','revision','runId','sharedOwnerUrl','target','version']::text[] OR
    p_plan->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(p_plan->'target') IS DISTINCT FROM 'string' OR
    length(p_plan->>'target') NOT BETWEEN 1 AND 256 OR jsonb_typeof(p_plan->'runId') IS DISTINCT FROM 'string' OR
    (p_plan->>'runId') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR
    jsonb_typeof(p_plan->'revision') IS DISTINCT FROM 'string' OR (p_plan->>'revision') !~ '^[0-9]{1,19}$' OR
    jsonb_typeof(p_plan->'epoch') IS DISTINCT FROM 'string' OR (p_plan->>'epoch') !~ '^[0-9]{1,19}$' OR
    jsonb_typeof(p_plan->'sharedOwnerUrl') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_plan->'leaseActive') IS DISTINCT FROM 'boolean' OR
    jsonb_typeof(p_plan->'pages') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'assetSummary') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 IF jsonb_array_length(p_plan->'pages') NOT BETWEEN 1 AND 20000 OR
    EXISTS(SELECT FROM jsonb_array_elements(p_plan->'pages') page WHERE jsonb_typeof(page) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(p_plan->'pages') page WHERE page->>'id'=p_plan->>'target') OR
    EXISTS(SELECT FROM jsonb_array_elements(p_plan->'pages') page WHERE
     (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(page) k) IS DISTINCT FROM ARRAY['href','id','kind','slug']::text[] OR
     jsonb_typeof(page->'id') IS DISTINCT FROM 'string' OR length(page->>'id') NOT BETWEEN 1 AND 256 OR
     jsonb_typeof(page->'href') IS DISTINCT FROM 'string' OR (page->>'href') !~ '^/[a-zA-Z0-9/_#%.-]+$' OR
     jsonb_typeof(page->'kind') IS DISTINCT FROM 'string' OR (page->>'kind') NOT IN ('status','course','study-note','post','album','book','movie','game','project','page') OR
     jsonb_typeof(page->'slug') IS DISTINCT FROM 'string' OR length(page->>'slug')>256) THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 summary:=p_plan->'assetSummary';
 IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(summary) k) IS DISTINCT FROM ARRAY['algorithm','count','digest','sample']::text[] OR
    summary->'algorithm' IS DISTINCT FROM '"nb-withdraw-assets-sha256-v1"'::jsonb OR
    jsonb_typeof(summary->'count') IS DISTINCT FROM 'number' OR (summary->>'count') !~ '^(0|[1-9][0-9]{0,5})$' OR
    jsonb_typeof(summary->'digest') IS DISTINCT FROM 'string' OR (summary->>'digest') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 IF (summary->>'count')::integer>400000 OR
    ((summary->>'count')::integer=0 AND summary->'sample' IS DISTINCT FROM 'null'::jsonb) OR
    ((summary->>'count')::integer>0 AND (jsonb_typeof(summary->'sample') IS DISTINCT FROM 'string' OR
      octet_length(summary->>'sample')<>67 OR (summary->>'sample') COLLATE "C" !~ '^a1[.][a-f0-9]{64}$')) THEN RAISE EXCEPTION 'NB_CACHE_PLAN'; END IF;
 PERFORM 1 FROM nb_cache.state WHERE singleton FOR UPDATE;
 SELECT * INTO prior FROM nb_cache.events WHERE id=p_event;
 IF FOUND THEN
   IF prior.scope<>'withdraw' OR prior.payload<>p_plan THEN RAISE EXCEPTION 'NB_CACHE_EVENT_CONFLICT'; END IF;
   RETURN jsonb_build_object('id',prior.id,'generation',prior.generation::text,'status',prior.status);
 END IF;
 SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE NOWAIT;
 IF s.lease_run IS NOT NULL THEN RAISE EXCEPTION 'NB_CACHE_SYNC_BUSY'; END IF;
 -- This distinct query starts after the locks, using the VOLATILE caller's fresh snapshot.
 SELECT nb_cache_api.plan_withdraw_compact(p_plan->>'target') INTO actual;
 IF actual<>p_plan OR (actual->>'sharedOwnerUrl')::boolean THEN RAISE EXCEPTION 'NB_CACHE_PLAN_CHANGED'; END IF;
 PERFORM nb_v2_api.set_denied(p_plan->>'target',true);
 UPDATE nb_cache.state SET generation=generation+1 WHERE singleton RETURNING generation INTO gen;
 INSERT INTO nb_cache.events(id,scope,publication_version,payload,generation) VALUES(p_event,'withdraw',p_plan->>'revision',p_plan,gen);
 RETURN jsonb_build_object('id',p_event,'generation',gen::text,'status','pending');
END $$;

REVOKE EXECUTE ON FUNCTION nb_cache_api.plan_withdraw_compact(text),nb_cache_api.withdraw_compact(uuid,jsonb) FROM PUBLIC,nb_reader,nb_writer,nb_cache_publisher;
DO $$ DECLARE actor text; BEGIN
 FOR actor IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
   EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION nb_cache_api.plan_withdraw_compact(text),nb_cache_api.withdraw_compact(uuid,jsonb) FROM %I',actor);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_cache_api.plan_withdraw_compact(text),nb_cache_api.withdraw_compact(uuid,jsonb) TO nb_cache_operator;
COMMIT;
