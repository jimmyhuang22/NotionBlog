-- Follow 001 on self-hosted installations with the display and freeze extensions.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SELECT nb_display.lock_state();
SELECT singleton FROM nb_freeze_payload.migrations WHERE singleton FOR UPDATE;
SELECT singleton FROM nb_display.migrations WHERE singleton FOR UPDATE;

DO $$
BEGIN
  IF (SELECT nb_display_api.check_capability(digest) FROM nb_display.migrations WHERE singleton) IS DISTINCT FROM true
     OR (SELECT nb_freeze_payload_api.check_capability(digest) FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_display_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb,text,jsonb,uuid,text)'::regprocedure)
        IS DISTINCT FROM '84714d5630289441137acf56b63868ea'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_display.find_asset(uuid,text)'::regprocedure)
        IS DISTINCT FROM '55ad1a2de897ed4abb46946943a15e2b'
  THEN RAISE EXCEPTION 'NB_DISPLAY_COPY_BASE_MISMATCH'; END IF;
END $$;

CREATE OR REPLACE FUNCTION nb_display_api.apply_delta(p_operation uuid,p_digest text,p_expected text,p_config text,
 p_records jsonb,p_media jsonb,p_withdrawals jsonb,p_recipe text,p_assets jsonb,p_group uuid,p_generation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old nb_display.operations; request jsonb; result jsonb; previous uuid; r uuid; a jsonb; m record; copied jsonb; prior_asset jsonb; prior_recipe text; BEGIN
 IF p_recipe IS DISTINCT FROM 'display-webp-v2:4adf9c0a89fe1f690c07a43576721c82b550e32ee3239ad9fd4711c342a5cb62' THEN RAISE EXCEPTION 'NB_DISPLAY_RECIPE_INVALID'; END IF;
 PERFORM nb_display.lock_state();
 request:=jsonb_build_object('digest',p_digest,'expected',p_expected,'config',p_config,'records',p_records,'media',p_media,'withdrawals',p_withdrawals,
  'recipe',p_recipe,'assets',p_assets,'group',p_group,'generation',p_generation);
 SELECT * INTO old FROM nb_display.operations WHERE operation_id=p_operation;
 IF old.operation_id IS NOT NULL THEN
  IF old.request IS DISTINCT FROM request OR old.action IS DISTINCT FROM (CASE WHEN p_group IS NULL THEN 'delta' ELSE 'refresh' END) THEN
   RAISE EXCEPTION 'NB_DELTA_OPERATION_CONFLICT'; END IF; RETURN old.receipt;
 END IF;
 IF jsonb_typeof(p_assets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_assets)>100 OR octet_length(p_assets::text)>16777216 OR
  EXISTS(SELECT FROM jsonb_array_elements(p_assets) x GROUP BY x->>'assetId' HAVING count(*)>1) OR
  (p_group IS NULL)<>(p_generation IS NULL) THEN RAISE EXCEPTION 'NB_DISPLAY_ASSET_INVALID'; END IF;
 previous:=nb_display.run('published');
 IF p_group IS NULL THEN result:=nb_delta_api.apply_delta(p_operation,p_digest,p_expected,p_config,p_records,p_media,p_withdrawals);
 ELSE
  DELETE FROM nb_display.frozen WHERE group_id=p_group;
  result:=nb_freeze_api.refresh_delta(p_operation,p_group,p_generation,p_digest,p_expected,p_config,p_records,p_media,p_withdrawals);
 END IF;
 r:=nb_display.run('published');
 IF r IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'NB_DELTA_OPERATION_CONFLICT'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
  IF NOT EXISTS(SELECT FROM jsonb_array_elements(p_media) original WHERE original->>'assetId'=a->>'assetId') THEN RAISE EXCEPTION 'NB_DISPLAY_SOURCE_MISMATCH'; END IF;
  PERFORM nb_display.put_asset(r,p_recipe,a);
 END LOOP;
 FOR m IN SELECT * FROM nb_v2.media WHERE run_id=r AND nb_v2.record_eligible(r,owner_page_id) LOOP
  IF EXISTS(SELECT FROM nb_display.assets WHERE run_id=r AND asset_id=m.asset_id) THEN CONTINUE; END IF;
  copied:=nb_display.find_asset(previous,m.asset_id);
  IF copied IS NULL OR copied->>'sourceSha256' IS DISTINCT FROM m.descriptor->>'sha256' OR copied->>'ownerPageId' IS DISTINCT FROM m.owner_page_id THEN
   RAISE EXCEPTION 'NB_DISPLAY_MEDIA_NOT_READY'; END IF;
  -- Probe the unique (run_id, asset_id) row before comparing the JSON.
  -- A combined filter and sort can visit every historical copy for every asset.
  SELECT x.asset, x.recipe INTO prior_asset, prior_recipe FROM nb_display.assets x
  WHERE x.run_id = previous AND x.asset_id = m.asset_id;
  IF prior_asset = copied THEN
   INSERT INTO nb_display.assets VALUES (r, m.asset_id, prior_recipe, copied);
  ELSE
   INSERT INTO nb_display.assets
   SELECT r, m.asset_id, x.recipe, copied FROM nb_display.assets x
   WHERE x.asset_id = m.asset_id AND x.asset = copied
   ORDER BY x.run_id DESC LIMIT 1;
   IF NOT FOUND THEN RAISE EXCEPTION 'NB_DISPLAY_MEDIA_NOT_READY'; END IF;
  END IF;
 END LOOP;
 IF p_group IS NOT NULL THEN PERFORM nb_display.snapshot_group(p_group,r); END IF;
 INSERT INTO nb_display.operations VALUES(p_operation,CASE WHEN p_group IS NULL THEN 'delta' ELSE 'refresh' END,request,result);
 RETURN result;
END $$;

UPDATE nb_display.migrations
SET definitions = jsonb_set(definitions, ARRAY[p.oid::regprocedure::text], to_jsonb(md5(pg_get_functiondef(p.oid))), false)
FROM pg_proc p WHERE singleton AND p.oid = 'nb_display_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb,text,jsonb,uuid,text)'::regprocedure;

-- The freeze extension separately attests this entry point, its owner and grants.
UPDATE nb_freeze_payload.migrations
SET definitions = jsonb_set(definitions, ARRAY[p.oid::regprocedure::text],
  to_jsonb(md5(pg_get_functiondef(p.oid) || COALESCE(p.proacl::text, '') || pg_get_userbyid(p.proowner))), false)
FROM pg_proc p WHERE singleton AND p.oid = 'nb_display_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb,text,jsonb,uuid,text)'::regprocedure;

DO $$
BEGIN
  IF (SELECT nb_display_api.check_capability(digest) FROM nb_display.migrations WHERE singleton) IS DISTINCT FROM true
     OR (SELECT nb_freeze_payload_api.check_capability(digest) FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'NB_DISPLAY_COPY_CAPABILITY_MISMATCH'; END IF;
END $$;
COMMIT;
