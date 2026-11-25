-- Optional self-hosted migration. Run with psql ON_ERROR_STOP, outside a transaction.
-- The bounded C-collated text key lets the reader advance past all equal copies.
-- Larger descriptions use a separate partial index so their exact values can
-- be compared without storing an unbounded key or visiting the short copies.
SET lock_timeout = '5s';
SET statement_timeout = '12min';

CREATE INDEX CONCURRENTLY frozen_variant_keys ON nb_thumbnails.media (
  parent_asset_id, parent_sha,
  (CASE WHEN octet_length(descriptor::text) <= 1400 THEN descriptor::text END) COLLATE "C"
) WHERE version = 'v2';

CREATE INDEX CONCURRENTLY frozen_variant_overflow ON nb_thumbnails.media (
  parent_asset_id, parent_sha
) WHERE version = 'v2' AND octet_length(descriptor::text) > 1400;

RESET statement_timeout;
RESET lock_timeout;
