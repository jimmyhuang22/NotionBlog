-- Derived counts only. Existing ingest payloads, activity, grants and RLS stay intact.
BEGIN;
CREATE FUNCTION social_sync.valid_collection_addition_history(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE e jsonb;videos bigint:=0;parts bigint:=0;BEGIN
 IF p IS NULL THEN RETURN true;END IF;
 IF NOT social_sync.collection_exact_keys(p,ARRAY['version','completeSince','contributions']) OR p->'version'<>'1'::jsonb OR
    NOT social_sync.valid_time(p->'completeSince') OR jsonb_typeof(p->'contributions')<>'array' OR
    jsonb_array_length(p->'contributions')>30000 OR octet_length(p::text)>8388608 THEN RETURN false;END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'contributions') LOOP
  IF NOT social_sync.collection_exact_keys(e,ARRAY['at','detectedAt','basis','addedVideos','addedParts']) OR
     jsonb_typeof(e->'at')<>'string' OR jsonb_typeof(e->'detectedAt')<>'string' OR
     NOT social_sync.valid_time(e->'at') OR NOT social_sync.valid_time(e->'detectedAt') OR
     jsonb_typeof(e->'basis')<>'string' OR e->>'basis' NOT IN ('member-published','addition-detected') OR
     NOT social_sync.valid_count(e->'addedVideos') OR NOT social_sync.valid_count(e->'addedParts') OR
     e->'addedVideos'='null'::jsonb OR e->'addedParts'='null'::jsonb OR
     (e->>'addedVideos')::bigint+(e->>'addedParts')::bigint<1 OR
     (e->>'at')::timestamptz>(e->>'detectedAt')::timestamptz+interval '30 seconds' OR
     (e->>'basis'='addition-detected' AND e->>'at'<>e->>'detectedAt') THEN RETURN false;END IF;
  videos:=videos+(e->>'addedVideos')::bigint;parts:=parts+(e->>'addedParts')::bigint;
 END LOOP;
 RETURN videos<=10000 AND parts<=20000;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
ALTER TABLE social_sync.collection_states ADD COLUMN addition_history jsonb
 CHECK(social_sync.valid_collection_addition_history(addition_history));
ALTER TABLE social_sync.retained_collections ADD COLUMN addition_history jsonb
 CHECK(social_sync.valid_collection_addition_history(addition_history));

-- Runs after collection_guard, so the public activity is already authoritative.
CREATE FUNCTION social_sync.guard_collection_addition_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE history jsonb;events jsonb;event jsonb;m jsonb;old_parts jsonb;n integer;at text;basis text;
 since text;cutoff timestamptz;BEGIN
 IF TG_OP='INSERT' THEN
  NEW.addition_history:=jsonb_build_object('version',1,'completeSince',NULL,'contributions','[]'::jsonb);RETURN NEW;
 END IF;
 IF NEW.observed_at=OLD.observed_at THEN
  -- Only a reviewed administrator can backfill the new derived column. The
  -- worker has no column write privilege, and cannot alter an existing ledger.
  IF NEW.addition_history IS DISTINCT FROM OLD.addition_history THEN
   IF current_user='nb_social_worker' OR NOT social_sync.valid_collection_addition_history(NEW.addition_history) THEN
    RAISE EXCEPTION 'NB_COLLECTION_ADDITION_BACKFILL';END IF;
  END IF;
  RETURN NEW;
 END IF;
 history:=OLD.addition_history;
 since:=CASE WHEN history IS NULL THEN OLD.observed_at ELSE history->>'completeSince' END;
 events:=coalesce(history->'contributions','[]'::jsonb);
 FOR m IN SELECT value FROM jsonb_array_elements(NEW.payload->'members') LOOP
  IF NOT (OLD.seen_videos ? (m->>'id')) THEN
   IF NEW.payload->'target'->>'kind'='season' THEN
    -- A late-discovered old video has no known membership-addition time,
    -- preserving the existing member-published/addition-detected distinction.
    at:=CASE WHEN m->>'publishedAt'>=OLD.observed_at THEN m->>'publishedAt' ELSE NULL END;
    basis:=CASE WHEN at IS NULL THEN 'addition-detected' ELSE 'member-published' END;
    events:=events||jsonb_build_array(jsonb_build_object('at',coalesce(at,NEW.observed_at),'detectedAt',NEW.observed_at,
      'basis',basis,'addedVideos',1,'addedParts',0));
   END IF;
  ELSE
   old_parts:=OLD.part_baselines->(m->>'id')->'ids';
   IF old_parts IS NOT NULL AND m->'partsComplete'='true'::jsonb THEN
    SELECT count(*) INTO n FROM jsonb_array_elements_text(m->'parts') WHERE NOT (old_parts ? value);
    IF n>0 THEN events:=events||jsonb_build_array(jsonb_build_object('at',NEW.observed_at,'detectedAt',NEW.observed_at,
      'basis','addition-detected','addedVideos',0,'addedParts',n));END IF;
   END IF;
  END IF;
 END LOOP;
 -- Retain the complete activity day in every site timezone, including DST.
 -- Metric-only refreshes do not advance activity, so old displayed counts stay.
 cutoff:=(NEW.card->'activity'->>'at')::timestamptz-interval '72 hours';
 IF cutoff IS NOT NULL AND (since IS NULL OR since::timestamptz<cutoff) THEN
  since:=to_char(cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('at',v.at,'detectedAt',v.detected_at,'basis',v.basis,
   'addedVideos',v.videos,'addedParts',v.parts) ORDER BY v.at,v.detected_at,v.basis),'[]'::jsonb) INTO events FROM (
   SELECT e->>'at' AS at,e->>'detectedAt' AS detected_at,e->>'basis' AS basis,
     sum((e->>'addedVideos')::integer) AS videos,sum((e->>'addedParts')::integer) AS parts
   FROM jsonb_array_elements(events) e WHERE cutoff IS NULL OR (e->>'at')::timestamptz>=cutoff
   GROUP BY e->>'at',e->>'detectedAt',e->>'basis'
 ) v;
 NEW.addition_history:=jsonb_build_object('version',1,'completeSince',since,'contributions',events);
 RETURN NEW;
END $$;
CREATE TRIGGER collection_z_addition_history_guard BEFORE INSERT OR UPDATE ON social_sync.collection_states
 FOR EACH ROW EXECUTE FUNCTION social_sync.guard_collection_addition_history();

-- Copy derived evidence through the existing approved-source bridge. This does
-- not relax source-state freshness RLS to make retained counts readable.
CREATE FUNCTION social_sync.guard_retained_addition_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT NEW.approved THEN NEW.addition_history:=NULL;RETURN NEW;END IF;
 SELECT s.addition_history INTO NEW.addition_history FROM social_sync.collection_states s
  WHERE s.collection_key=NEW.collection_key AND s.payload_sha256=NEW.source_sha256;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_retained_z_addition_history BEFORE INSERT OR UPDATE ON social_sync.retained_collections
 FOR EACH ROW EXECUTE FUNCTION social_sync.guard_retained_addition_history();

-- Both sources use their existing RLS. A frozen reviewed card is bounded by its
-- approved latestAddition, even after later statistics-only refreshes.
CREATE FUNCTION social_sync.collection_day_addition(p_key text,p_activity text,p_observed text,p_zone text,p_retained boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h jsonb;cutoff text;day date;start_at timestamptz;videos bigint;parts bigint;published boolean;detected boolean;BEGIN
 IF p_activity IS NULL THEN RETURN NULL;END IF;
 IF p_retained THEN
 SELECT r.addition_history,r.card->'latestAddition'->>'detectedAt' INTO h,cutoff
 FROM social_sync.retained_collections r WHERE r.collection_key=p_key AND r.approved
  AND r.observed_at=p_observed AND r.card->'activity'->>'at'=p_activity;
 ELSE
  SELECT s.addition_history,s.card->'latestAddition'->>'detectedAt' INTO h,cutoff
  FROM social_sync.collection_states s WHERE s.collection_key=p_key AND s.observed_at=p_observed
   AND s.card->'activity'->>'at'=p_activity;
 END IF;
 IF h IS NULL OR cutoff IS NULL THEN RETURN NULL;END IF;
 day:=(p_activity::timestamptz AT TIME ZONE p_zone)::date;
 start_at:=day::timestamp AT TIME ZONE p_zone;
 IF h->>'completeSince' IS NOT NULL AND (h->>'completeSince')::timestamptz>start_at THEN RETURN NULL;END IF;
 SELECT coalesce(sum((e->>'addedVideos')::integer),0),coalesce(sum((e->>'addedParts')::integer),0),
   coalesce(bool_or(e->>'basis'='member-published'),false),coalesce(bool_or(e->>'basis'='addition-detected'),false)
 INTO videos,parts,published,detected FROM jsonb_array_elements(h->'contributions') e
 WHERE ((e->>'at')::timestamptz AT TIME ZONE p_zone)::date=day AND e->>'detectedAt'<=cutoff;
 IF videos+parts=0 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('day',to_char(day,'YYYY-MM-DD'),'addedVideos',videos,'addedParts',parts,
   'basis',CASE WHEN published AND detected THEN 'mixed' WHEN published THEN 'member-published' ELSE 'addition-detected' END);
END $$;
REVOKE ALL ON FUNCTION social_sync.valid_collection_addition_history(jsonb),social_sync.guard_collection_addition_history(),social_sync.guard_retained_addition_history(),
 social_sync.collection_day_addition(text,text,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT EXECUTE ON FUNCTION social_sync.valid_collection_addition_history(jsonb),social_sync.guard_collection_addition_history() TO nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.collection_day_addition(text,text,text,text,boolean) TO nb_social_reader;
GRANT SELECT(addition_history) ON social_sync.collection_states TO nb_social_reader;
GRANT SELECT(addition_history) ON social_sync.retained_collections TO nb_social_reader;
COMMIT;
