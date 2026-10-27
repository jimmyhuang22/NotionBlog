-- Opt-in frozen publication. Installation is inactive and creates no LOGIN or schedule.
BEGIN;
CREATE SCHEMA nb_freeze;
CREATE SCHEMA nb_freeze_api;
REVOKE ALL ON SCHEMA nb_freeze,nb_freeze_api FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='nb_freeze_operator') THEN
  CREATE ROLE nb_freeze_operator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='nb_freeze_operator' AND
  (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
  EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='nb_freeze_operator')) THEN
  RAISE EXCEPTION 'NB_FREEZE_ROLE_INVALID';
 END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_freeze REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_freeze,nb_freeze_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_freeze.state(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1),
 migration_digest text,enabled boolean NOT NULL DEFAULT false,generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0));
INSERT INTO nb_freeze.state VALUES(true,1,NULL,false,0);
CREATE TABLE nb_freeze.groups(id uuid PRIMARY KEY,root_id text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE nb_freeze.members(page_id text PRIMARY KEY,group_id uuid NOT NULL REFERENCES nb_freeze.groups(id),
 record jsonb NOT NULL,media jsonb NOT NULL CHECK(jsonb_typeof(media)='array'));
CREATE INDEX frozen_members_group ON nb_freeze.members(group_id);
CREATE TABLE nb_freeze.operations(id uuid PRIMARY KEY,action text NOT NULL CHECK(action IN ('freeze','permanent','once')),
 request jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE nb_freeze.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_freeze.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_freeze.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_freeze.operations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION nb_freeze_api.check_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM nb_freeze.state WHERE singleton AND version=1 AND migration_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$') AND
 (to_regclass('nb_thumbnails.media') IS NULL OR EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('nb_thumbnails.media') AND tgname='preserve_frozen_media' AND NOT tgisinternal))
$$;
CREATE FUNCTION nb_freeze.subtree(p_run uuid,p_root text) RETURNS SETOF text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE tree AS(
  SELECT id FROM nb_v2.records WHERE run_id=p_run AND id=p_root
  UNION SELECT r.id FROM nb_v2.records r JOIN tree t ON r.parent_id=t.id WHERE r.run_id=p_run
 ) SELECT id FROM tree
$$;
CREATE FUNCTION nb_freeze.record(p_run uuid,p_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT to_jsonb(r)-'run_id' FROM nb_v2.records r WHERE run_id=p_run AND id=p_id
$$;
CREATE FUNCTION nb_freeze.media(p_run uuid,p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE originals jsonb; variants jsonb:='[]'; BEGIN
 SELECT COALESCE(jsonb_agg(m.descriptor),'[]') INTO originals FROM nb_v2.media m WHERE run_id=p_run AND owner_page_id=p_id;
 IF to_regclass('nb_thumbnails.media') IS NOT NULL THEN
  SELECT COALESCE(jsonb_agg(t.descriptor),'[]') INTO variants FROM nb_thumbnails.media t JOIN nb_v2.media m
   ON t.parent_asset_id=m.asset_id AND t.parent_sha=m.descriptor->>'sha256'
   WHERE t.version='v2' AND m.run_id=p_run AND m.owner_page_id=p_id;
 END IF;
 RETURN (SELECT COALESCE(jsonb_agg(value ORDER BY value->>'assetId'),'[]') FROM
  (SELECT value FROM jsonb_array_elements(originals) UNION SELECT value FROM jsonb_array_elements(variants)) unique_media);
END
$$;
CREATE FUNCTION nb_freeze.resolve(p_run uuid,p_target text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE ids text[];
BEGIN
 SELECT array_agg(id) INTO ids FROM nb_v2.records WHERE run_id=p_run AND
  (id=p_target OR item->>'href'=p_target OR kind||'-'||(item->>'slug')=p_target);
 IF cardinality(ids) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FOUND'; END IF;
 RETURN ids[1];
END $$;
CREATE FUNCTION nb_freeze_api.read_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; result jsonb;
BEGIN
 r:=nb_publication.current_snapshot();
 SELECT jsonb_build_object('enabled',s.enabled,'generation',s.generation::text,'configDigest',(SELECT config_digest FROM nb_v2.state WHERE singleton),
  'publicationRevision',r.id::text||':'||(SELECT revision::text FROM nb_v2.state WHERE singleton),
  'publishedAt',(SELECT published_at FROM nb_publication.state WHERE singleton),
  'members',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.page_id,'sourceKey',m.record->>'source_key',
   'groupId',g.id,'rootId',g.root_id,'frozenAt',g.created_at) ORDER BY m.page_id),'[]')
   FROM nb_freeze.members m JOIN nb_freeze.groups g ON g.id=m.group_id)) INTO result FROM nb_freeze.state s WHERE singleton;
 RETURN result;
END $$;
CREATE FUNCTION nb_freeze_api.preview(p_target text,p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; root text; g uuid; f nb_freeze.state; selected jsonb; assets jsonb; missing integer;
 payload jsonb; item jsonb; n integer;
BEGIN
 IF p_target IS NULL OR length(p_target)>2000 OR p_action IS NULL OR p_action NOT IN ('freeze','permanent','once') THEN RAISE EXCEPTION 'NB_FREEZE_INPUT_INVALID'; END IF;
 r:=nb_publication.current_snapshot(); SELECT * INTO f FROM nb_freeze.state WHERE singleton;
 IF NOT f.enabled OR f.migration_digest IS NULL THEN RAISE EXCEPTION 'NB_FREEZE_DISABLED'; END IF;
 root:=nb_freeze.resolve(r.id,p_target);
 SELECT group_id INTO g FROM nb_freeze.members WHERE page_id=root;
 IF p_action='freeze' THEN
  IF NOT nb_v2.record_eligible(r.id,root) THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FOUND'; END IF;
  IF EXISTS(SELECT FROM nb_freeze.members WHERE page_id IN(SELECT nb_freeze.subtree(r.id,root))) THEN RAISE EXCEPTION 'NB_FREEZE_ALREADY_FROZEN'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('record',nb_freeze.record(r.id,id),'media',nb_freeze.media(r.id,id)) ORDER BY id),'[]')
   INTO selected FROM nb_freeze.subtree(r.id,root) id WHERE nb_v2.record_eligible(r.id,id);
 ELSE
  IF g IS NULL OR NOT EXISTS(SELECT FROM nb_freeze.groups WHERE id=g AND root_id=root) THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FROZEN'; END IF;
  SELECT jsonb_agg(jsonb_build_object('record',record,'media',media) ORDER BY page_id) INTO selected FROM nb_freeze.members WHERE group_id=g;
 END IF;
 n:=jsonb_array_length(selected);
 IF n NOT BETWEEN 1 AND 20000 OR octet_length(selected::text)>67108864 THEN RAISE EXCEPTION 'NB_FREEZE_LIMIT'; END IF;
 SELECT COALESCE(jsonb_agg(x.value ORDER BY x.value->>'assetId'),'[]') INTO assets
  FROM jsonb_array_elements(selected) s CROSS JOIN LATERAL jsonb_array_elements(s->'media') x;
 SELECT count(*) INTO missing FROM jsonb_array_elements(selected) s CROSS JOIN LATERAL
  jsonb_path_query(jsonb_build_array(s->'record'->'item',s->'record'->'document'),'$.** ? (@.src != null && @.id != null)') img
  WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(s->'media') m WHERE m->>'assetId'=img->>'id' AND img->>'src'='/media/v2/'||(m->>'assetId'));
 SELECT x.item INTO item FROM nb_v2.records x WHERE run_id=r.id AND id=root;
 payload:=jsonb_build_object('action',p_action,'root',root,'group',g,'generation',f.generation,
  'publicationRevision',r.id::text||':'||(SELECT revision::text FROM nb_v2.state WHERE singleton),
  'denied',(SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM nb_v2.denied),'selected',selected);
 RETURN jsonb_build_object('action',p_action,'rootId',root,'groupId',g,'generation',f.generation::text,
  'publicationRevision',payload->>'publicationRevision','digest',encode(sha256(convert_to(payload::text,'UTF8')),'hex'),
  'members',(SELECT jsonb_agg(jsonb_build_object('id',x->'record'->>'id','sourceKey',x->'record'->>'source_key','title',x->'record'->'item'->>'title') ORDER BY x->'record'->>'id') FROM jsonb_array_elements(selected) x),
  'pages',n,'images',jsonb_array_length(assets),'missingImages',missing,'media',assets,
  'thumbnailIds',(SELECT COALESCE(jsonb_agg(m->>'assetId'),'[]') FROM jsonb_array_elements(assets) m WHERE NOT EXISTS(
    SELECT FROM nb_v2.media original WHERE original.run_id=r.id AND original.asset_id=m->>'assetId')),
  'title',item->>'title','href',item->>'href','kind',item->>'kind');
END $$;
-- Public metadata only; bodies and source keys are never sent to the console.
CREATE FUNCTION nb_freeze.item(p_run uuid,p_id text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'section',CASE WHEN r.kind IN ('course','study-note') THEN 'study' ELSE r.kind END,
  'title',r.item->>'title','subtitle',r.item->>'code','href',r.item->>'href','parentId',r.parent_id,
  'childCount',(SELECT count(*) FROM nb_v2.records c WHERE c.run_id=p_run AND c.parent_id=r.id AND nb_v2.record_eligible(p_run,c.id)),
  'state',CASE WHEN NOT nb_v2.record_eligible(p_run,r.id) THEN 'withdrawn' WHEN m.page_id IS NOT NULL THEN 'frozen' ELSE 'syncing' END,
  'inheritedFrozen',COALESCE(g.root_id<>r.id,false),'frozenAt',g.created_at,'sourceEditedAt',r.item->>'updatedAt',
  'publishedAt',(SELECT published_at FROM nb_publication.state WHERE singleton),'consoleEdited',false)
 FROM nb_v2.records r LEFT JOIN nb_freeze.members m ON m.page_id=r.id LEFT JOIN nb_freeze.groups g ON g.id=m.group_id
 WHERE r.run_id=p_run AND r.id=p_id
$$;
CREATE FUNCTION nb_freeze_api.resolve_item(p_target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; BEGIN r:=nb_publication.current_snapshot(); RETURN nb_freeze.item(r.id,nb_freeze.resolve(r.id,p_target)); END $$;
CREATE FUNCTION nb_freeze_api.resolve_task(p_target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; root text; BEGIN
 r:=nb_publication.current_snapshot(); root:=nb_freeze.resolve(r.id,p_target);
 IF NOT nb_v2.record_eligible(r.id,root) THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FOUND'; END IF;
 RETURN (SELECT jsonb_build_object('pageKey',id,'sourceKey',source_key) FROM nb_v2.records WHERE run_id=r.id AND id=root);
END $$;
CREATE FUNCTION nb_freeze_api.list_content(p_section text,p_parent text,p_search text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; result jsonb; BEGIN
 r:=nb_publication.current_snapshot();
 IF p_section IS NULL OR p_section NOT IN ('study','status','movie','book','game','album','page') OR length(p_parent)>200 OR length(p_search)>200 THEN RAISE EXCEPTION 'NB_FREEZE_INPUT_INVALID'; END IF;
 WITH selected AS(SELECT x.id,x.ordinal,x.item->>'title' AS title FROM nb_v2.records x WHERE x.run_id=r.id AND nb_v2.record_eligible(r.id,x.id)
  AND (CASE WHEN p_section='study' THEN x.kind IN ('course','study-note') ELSE x.kind=p_section END)
  AND (CASE WHEN COALESCE(p_search,'')<>'' THEN x.item->>'title' ILIKE '%'||p_search||'%'
       WHEN p_parent IS NOT NULL THEN x.parent_id=p_parent ELSE x.parent_id IS NULL END)),
 page AS(SELECT * FROM selected ORDER BY ordinal,title,id LIMIT 500)
 SELECT jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(nb_freeze.item(r.id,id) ORDER BY ordinal,title,id),'[]') FROM page),
  'total',(SELECT count(*) FROM selected)) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION nb_freeze_api.sections() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; BEGIN
 r:=nb_publication.current_snapshot();
 RETURN (SELECT jsonb_agg(jsonb_build_object('section',section,'count',(SELECT count(*) FROM nb_v2.records x
  WHERE x.run_id=r.id AND x.kind=kinds.kind AND x.parent_id IS NULL AND nb_v2.record_eligible(r.id,x.id)),
  'frozen',(SELECT count(*) FROM nb_v2.records x JOIN nb_freeze.members m ON m.page_id=x.id
  WHERE x.run_id=r.id AND x.kind=kinds.kind AND x.parent_id IS NULL AND nb_v2.record_eligible(r.id,x.id))))
  FROM (VALUES('study','course'),('status','status'),('movie','movie'),('book','book'),('game','game'),('album','album')) kinds(section,kind));
END $$;
CREATE FUNCTION nb_freeze.lock_state() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM nb_v2.state WHERE singleton FOR UPDATE;
 PERFORM 1 FROM nb_publication.state WHERE singleton FOR UPDATE;
 PERFORM 1 FROM nb_freeze.state WHERE singleton FOR UPDATE;
 IF EXISTS(SELECT FROM nb_v2.state WHERE lease_run IS NOT NULL) THEN RAISE EXCEPTION 'NB_BUSY'; END IF;
END $$;
CREATE FUNCTION nb_freeze.capture(p_group uuid,p_run uuid,p_root text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 INSERT INTO nb_freeze.members SELECT id,p_group,nb_freeze.record(p_run,id),nb_freeze.media(p_run,id)
  FROM nb_freeze.subtree(p_run,p_root) id WHERE nb_v2.record_eligible(p_run,id);
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'NB_FREEZE_LIMIT'; END IF;
 RETURN n;
END $$;
CREATE FUNCTION nb_freeze_api.read_operation(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT result FROM nb_freeze.operations WHERE id=p_id $$;
CREATE FUNCTION nb_freeze_api.freeze(p_id uuid,p_root text,p_digest text,p_verified_media jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; request jsonb; old nb_freeze.operations; result jsonb; n integer;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'NB_FREEZE_INPUT_INVALID'; END IF;
 PERFORM nb_freeze.lock_state(); request:=jsonb_build_object('root',p_root,'digest',p_digest,'media',p_verified_media);
 SELECT * INTO old FROM nb_freeze.operations WHERE id=p_id;
 IF old.id IS NOT NULL THEN
  IF old.action<>'freeze' OR old.request<>request THEN RAISE EXCEPTION 'NB_FREEZE_OPERATION_CONFLICT'; END IF;
  RETURN old.result;
 END IF;
 plan:=nb_freeze_api.preview(p_root,'freeze');
 IF plan->>'digest' IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'NB_FREEZE_PREVIEW_STALE'; END IF;
 IF (plan->>'missingImages')::integer<>0 OR plan->'media' IS DISTINCT FROM p_verified_media THEN RAISE EXCEPTION 'NB_FREEZE_MEDIA_NOT_READY'; END IF;
 INSERT INTO nb_freeze.groups(id,root_id) VALUES(p_id,p_root);
 n:=nb_freeze.capture(p_id,split_part(plan->>'publicationRevision',':',1)::uuid,p_root);
 UPDATE nb_freeze.state SET generation=generation+1 WHERE singleton;
 result:=jsonb_build_object('operationId',p_id,'groupId',p_id,'pages',n,'generation',(SELECT generation::text FROM nb_freeze.state));
 INSERT INTO nb_freeze.operations(id,action,request,result) VALUES(p_id,'freeze',request,result);
 RETURN result;
END $$;
CREATE FUNCTION nb_freeze_api.unfreeze(p_id uuid,p_root text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE plan jsonb; request jsonb; old nb_freeze.operations; result jsonb; members jsonb;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'NB_FREEZE_INPUT_INVALID'; END IF;
 PERFORM nb_freeze.lock_state(); request:=jsonb_build_object('root',p_root,'digest',p_digest);
 SELECT * INTO old FROM nb_freeze.operations WHERE id=p_id;
 IF old.id IS NOT NULL THEN
  IF old.action<>'permanent' OR old.request<>request THEN RAISE EXCEPTION 'NB_FREEZE_OPERATION_CONFLICT'; END IF;
  RETURN old.result;
 END IF;
 plan:=nb_freeze_api.preview(p_root,'permanent');
 IF plan->>'digest' IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'NB_FREEZE_PREVIEW_STALE'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',page_id,'sourceKey',record->>'source_key') ORDER BY page_id) INTO members
  FROM nb_freeze.members WHERE group_id=(plan->>'groupId')::uuid;
 DELETE FROM nb_freeze.members WHERE group_id=(plan->>'groupId')::uuid;
 DELETE FROM nb_freeze.groups WHERE id=(plan->>'groupId')::uuid;
 UPDATE nb_freeze.state SET generation=generation+1 WHERE singleton;
 result:=jsonb_build_object('operationId',p_id,'generation',(SELECT generation::text FROM nb_freeze.state),'members',members);
 INSERT INTO nb_freeze.operations(id,action,request,result) VALUES(p_id,'permanent',request,result);
 RETURN result;
END $$;
-- Enforce preservation on every publisher, including old/full callers. Explicit deny still wins at read time.
CREATE FUNCTION nb_freeze.guard_publication() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.run_id IS NULL OR NEW.run_id IS NOT DISTINCT FROM OLD.run_id THEN RETURN NEW; END IF;
 IF EXISTS(SELECT FROM nb_freeze.members m WHERE nb_freeze.record(NEW.run_id,m.page_id) IS DISTINCT FROM m.record OR
  nb_freeze.media(NEW.run_id,m.page_id) IS DISTINCT FROM m.media) OR EXISTS(
  SELECT FROM nb_v2.records r JOIN nb_freeze.members m ON m.page_id=r.parent_id
  WHERE r.run_id=NEW.run_id AND NOT EXISTS(SELECT FROM nb_freeze.members child WHERE child.page_id=r.id AND child.group_id=m.group_id)) THEN
  RAISE EXCEPTION 'NB_FREEZE_PROTECTED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_frozen_publication BEFORE UPDATE OF run_id ON nb_publication.state
 FOR EACH ROW EXECUTE FUNCTION nb_freeze.guard_publication();
CREATE FUNCTION nb_freeze.guard_media() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.version='v2' AND EXISTS(SELECT FROM nb_freeze.members m WHERE
  m.page_id=OLD.descriptor->>'ownerPageId' AND m.media @> jsonb_build_array(OLD.descriptor)) AND
  (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'NB_FREEZE_PROTECTED'; END IF;
 IF TG_OP<>'DELETE' AND NEW.version='v2' AND EXISTS(SELECT FROM nb_freeze.members m WHERE
  m.page_id=NEW.descriptor->>'ownerPageId' AND EXISTS(SELECT FROM jsonb_array_elements(m.media) a WHERE a->>'assetId'=NEW.parent_asset_id) AND
  NOT m.media @> jsonb_build_array(NEW.descriptor)) THEN RAISE EXCEPTION 'NB_FREEZE_PROTECTED'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
-- Re-run the inactive installer after installing the optional thumbnail extension later.
CREATE FUNCTION nb_freeze.install_media_guard() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF to_regclass('nb_thumbnails.media') IS NOT NULL AND NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('nb_thumbnails.media') AND tgname='preserve_frozen_media') THEN
  CREATE TRIGGER preserve_frozen_media BEFORE INSERT OR UPDATE OR DELETE ON nb_thumbnails.media FOR EACH ROW EXECUTE FUNCTION nb_freeze.guard_media();
 END IF;
END $$;
SELECT nb_freeze.install_media_guard();
-- The trusted writer may replace one group atomically. Removing the old protection is invisible outside this transaction.
CREATE FUNCTION nb_freeze_api.refresh_delta(p_operation uuid,p_group uuid,p_generation text,p_digest text,p_expected text,p_config text,
 p_records jsonb,p_media jsonb,p_withdrawals jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old nb_freeze.operations; request jsonb; root text; result jsonb; new_run uuid;
BEGIN
 PERFORM nb_freeze.lock_state();
 request:=jsonb_build_object('group',p_group,'generation',p_generation,'digest',p_digest,'expected',p_expected,'config',p_config,
  'records',p_records,'media',p_media,'withdrawals',p_withdrawals);
 SELECT * INTO old FROM nb_freeze.operations WHERE id=p_operation;
 IF old.id IS NOT NULL THEN
  IF old.action<>'once' OR old.request<>request THEN RAISE EXCEPTION 'NB_FREEZE_OPERATION_CONFLICT'; END IF;
  RETURN old.result;
 END IF;
 IF EXISTS(SELECT FROM nb_delta.operations WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'NB_FREEZE_OPERATION_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT FROM nb_freeze.state WHERE enabled AND generation::text=p_generation) THEN RAISE EXCEPTION 'NB_FREEZE_PREVIEW_STALE'; END IF;
 SELECT root_id INTO root FROM nb_freeze.groups WHERE id=p_group;
 IF root IS NULL THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FROZEN'; END IF;
 DELETE FROM nb_freeze.members WHERE group_id=p_group;
 result:=nb_delta_api.apply_delta(p_operation,p_digest,p_expected,p_config,p_records,p_media,p_withdrawals);
 new_run:=(split_part(result->>'publicationRevision',':',1))::uuid;
 IF NOT nb_v2.record_eligible(new_run,root) THEN RAISE EXCEPTION 'NB_FREEZE_NOT_FOUND'; END IF;
 PERFORM nb_freeze.capture(p_group,new_run,root);
 UPDATE nb_freeze.state SET generation=generation+1 WHERE singleton;
 INSERT INTO nb_freeze.operations(id,action,request,result) VALUES(p_operation,'once',request,result);
 RETURN result;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_freeze FROM PUBLIC,nb_reader,nb_writer,nb_freeze_operator;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_freeze,nb_freeze_api FROM PUBLIC,nb_reader,nb_writer,nb_freeze_operator;
GRANT USAGE ON SCHEMA nb_freeze_api TO nb_reader,nb_writer,nb_freeze_operator;
GRANT EXECUTE ON FUNCTION nb_freeze_api.check_capability(text),nb_freeze_api.read_state(),nb_freeze_api.preview(text,text)
 TO nb_reader,nb_writer,nb_freeze_operator;
GRANT EXECUTE ON FUNCTION nb_freeze_api.resolve_item(text),nb_freeze_api.resolve_task(text),nb_freeze_api.list_content(text,text,text),nb_freeze_api.sections() TO nb_freeze_operator;
GRANT EXECUTE ON FUNCTION nb_freeze_api.freeze(uuid,text,text,jsonb),nb_freeze_api.unfreeze(uuid,text,text),nb_freeze_api.read_operation(uuid)
 TO nb_freeze_operator;
GRANT EXECUTE ON FUNCTION nb_freeze_api.refresh_delta(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb) TO nb_writer;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','nb_delta_reader') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA nb_freeze,nb_freeze_api FROM %I',r);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_freeze FROM %I',r);
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_freeze,nb_freeze_api FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='nb_delta_reader') THEN
  GRANT USAGE ON SCHEMA nb_freeze_api TO nb_delta_reader;
  GRANT EXECUTE ON FUNCTION nb_freeze_api.check_capability(text),nb_freeze_api.read_state() TO nb_delta_reader;
 END IF;
END $$;
COMMIT;
