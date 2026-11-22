-- Optional addition to the compact library selector. Older installs still hydrate the field.
BEGIN;

CREATE OR REPLACE FUNCTION nb_library.selector(p_item jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(p_item)
  WHERE key=ANY(ARRAY['id','kind','slug','href','title','tags'] || CASE p_item->>'kind'
    WHEN 'movie' THEN ARRAY['status','mediaType','watchedDate']
    WHEN 'book' THEN ARRAY['status','readingDate']
    WHEN 'game' THEN ARRAY['status','platforms','playedDate','lastPlayedDate','lastPlayedPlatforms','firstPlayedDate','archiveDate']
    ELSE ARRAY[]::text[] END)
$$;

COMMIT;
