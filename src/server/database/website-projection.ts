/** Keep eligibility checks in the existing reader functions, but send only the
 * allowed references actually present in the selected records over the wire.
 * The inner query and JSON paths are fixed server code, never user input. */
export function compactWebsiteProjection(query: string): string {
  return `WITH projection AS MATERIALIZED (${query}),
    hrefs AS MATERIALIZED (SELECT DISTINCT ref FROM projection,
      LATERAL jsonb_path_query(value->'records', '$.**.href') AS refs(ref)),
    ids AS MATERIALIZED (SELECT DISTINCT ref FROM projection,
      LATERAL jsonb_path_query(value->'records', '$.**.id') AS refs(ref))
    SELECT value - 'links' - 'mediaIds' || jsonb_build_object(
      'links', (SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb)
        FROM jsonb_array_elements(value->'links') AS allowed(ref) WHERE ref IN (SELECT ref FROM hrefs)),
      'mediaIds', (SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb)
        FROM jsonb_array_elements(value->'mediaIds') AS allowed(ref) WHERE ref IN (SELECT ref FROM ids))
    ) AS result FROM projection`;
}

export const WEBSITE_SNAPSHOT_SQL = compactWebsiteProjection(
  "SELECT nb_v2_api.read_snapshot($1::text[],$2) AS value");

// read_content honors both current qualification and optional run/revision pins.
// Unlike read_snapshot(false), it does not include every Status document.
export const WEBSITE_CONTENT_SQL = compactWebsiteProjection(
  "SELECT nb_v2_api.read_content($1,$3,NULL,'{}'::jsonb,$6,$7,$4::uuid,$5::bigint,$2) AS value");

// This private index is used only to sort/filter/count Status. The selected page
// is replaced by complete, freshly qualified DTOs before anything is returned.
export const WEBSITE_STATUS_INDEX_SQL = compactWebsiteProjection(`WITH content AS MATERIALIZED (
  SELECT nb_v2_api.read_content($1,$3,NULL,'{}'::jsonb,$6,$7,$4::uuid,$5::bigint,$2) AS value)
  SELECT jsonb_set(value, '{records}', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'item', jsonb_build_object('id',record->'item'->'id','kind',record->'item'->'kind',
      'slug',record->'item'->'slug','href',record->'item'->'href','title',record->'item'->'title',
      'tags',record->'item'->'tags','recordedAt',record->'item'->'recordedAt'),
    'document',NULL)), '[]'::jsonb) FROM jsonb_array_elements(value->'records') AS selected(record))) AS value
  FROM content`);

export const WEBSITE_STATUS_PAGE_SQL = compactWebsiteProjection(`SELECT
  jsonb_set(value, '{records}', (SELECT COALESCE(jsonb_agg(record), '[]'::jsonb)
    FROM jsonb_array_elements(value->'records') AS selected(record)
    WHERE record->'item'->>'slug' = ANY($3::text[]))) AS value
  FROM (SELECT nb_v2_api.read_snapshot($1::text[],$2) AS value) AS snapshot`);
